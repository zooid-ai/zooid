import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { createHmac } from 'node:crypto'
import { mountWebhookRoutes } from '../src/daemon/webhook-routes.js'
import { loadZooidConfig } from '@zooid/core'

const secret = 'topsecret'
const yaml = `
runtime: local
transports:
  matrix:
    type: matrix
    homeserver: http://localhost:8448
    as_token: t
    hs_token: h
    user_namespace: '@.*:example.org'
agents:
  product:
    acp: { preset: opencode }
    matrix: { rooms: ["#product:example.org"] }
  architect:
    acp: { preset: opencode }
    matrix: { rooms: ["#dev:example.org"] }
triggers:
  github:
    webhook:
      provider: github
      secret: "${secret}"
    as: "@hook:example.org"
    messages:
      - room: "!product:example.org"
        mention: product
        match: 'event == "issues" && body.action == "opened"'
        text: 'Triage \${body.repository.full_name}#\${body.issue.number}.'
      - room: "!dev:example.org"
        mention: architect
        match: 'event == "pull_request" && body.action == "closed" && body.pull_request.merged'
        text: 'PR \${body.number} merged.'
      - room: "!ops:example.org"
        mention: architect
        match: 'event == "issues"'
        text: 'Any issue activity.'
`

const sign = (b: string, s = secret) => `sha256=${createHmac('sha256', s).update(b).digest('hex')}`

const mk = () => {
  const sent: Array<Record<string, unknown>> = []
  const app = new Hono()
  mountWebhookRoutes(app, {
    triggers: loadZooidConfig(yaml).triggers,
    agentUserIds: { product: '@product:example.org', architect: '@architect:example.org' },
    resolveRoom: async (r: string) => r,
    ensureBot: async () => {},
    sendMessage: async (m: Record<string, unknown>) => {
      sent.push(m)
      return { event_id: '$1' }
    },
  })
  return { app, sent }
}

const post = (app: Hono, body: string, headers: Record<string, string>) =>
  app.request('/webhook/github', {
    method: 'POST',
    body,
    headers: { 'x-hub-signature-256': sign(body), ...headers },
  })

const issueOpened = JSON.stringify({
  action: 'opened',
  issue: { number: 23 },
  repository: { full_name: 'zooid-ai/zooid' },
})
const prMerged = JSON.stringify({ action: 'closed', number: 7, pull_request: { merged: true } })

describe('messages', () => {
  it('posts only the messages whose match holds, with placeholders rendered', async () => {
    const { app, sent } = mk()
    const res = await post(app, issueOpened, { 'x-github-event': 'issues', 'x-github-delivery': 'a1' })
    expect(res.status).toBe(202)
    // entries 0 and 2 match; entry 1 (merged PR) does not
    await vi.waitFor(() => expect(sent.length).toBe(2))
    const bodies = sent.map((m) => String((m.content as Record<string, string>).body))
    expect(bodies[0]).toBe('Triage zooid-ai/zooid#23.')
    expect(bodies[1]).toBe('Any issue activity.')
  })

  it('wakes the right agent per message', async () => {
    const { app, sent } = mk()
    await post(app, issueOpened, { 'x-github-event': 'issues', 'x-github-delivery': 'a2' })
    await vi.waitFor(() => expect(sent.length).toBe(2))
    expect((sent[0].content as Record<string, unknown>)['m.mentions']).toEqual({
      user_ids: ['@product:example.org'],
    })
    expect((sent[1].content as Record<string, unknown>)['m.mentions']).toEqual({
      user_ids: ['@architect:example.org'],
    })
  })

  // The merged-PR match reads body.pull_request.merged, which is a CelError on
  // an issues payload. That must read as "no match", not as an error that drops
  // the whole delivery.
  it('a match that errors on this payload blocks only its own message', async () => {
    const { app, sent } = mk()
    await post(app, issueOpened, { 'x-github-event': 'issues', 'x-github-delivery': 'a3' })
    await vi.waitFor(() => expect(sent.length).toBe(2))
    expect(sent.map((m) => m.roomId)).toEqual(['!product:example.org', '!ops:example.org'])
  })

  it('routes a merged PR to the other room', async () => {
    const { app, sent } = mk()
    const res = await post(app, prMerged, { 'x-github-event': 'pull_request', 'x-github-delivery': 'b1' })
    expect(res.status).toBe(202)
    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(sent[0].roomId).toBe('!dev:example.org')
    expect(String((sent[0].content as Record<string, string>).body)).toBe('PR 7 merged.')
  })

  it('acknowledges a delivery that matches nothing and posts nothing', async () => {
    const { app, sent } = mk()
    const res = await post(app, JSON.stringify({ action: 'deleted' }), {
      'x-github-event': 'release',
      'x-github-delivery': 'c1',
    })
    expect(res.status).toBe(202)
    await new Promise((r) => setTimeout(r, 50))
    expect(sent.length).toBe(0)
  })

  it('still rejects a bad signature before any match runs', async () => {
    const { app, sent } = mk()
    const res = await app.request('/webhook/github', {
      method: 'POST',
      body: issueOpened,
      headers: { 'x-hub-signature-256': sign(issueOpened, 'wrong'), 'x-github-event': 'issues' },
    })
    expect(res.status).toBe(401)
    expect(sent.length).toBe(0)
  })

  it('dedupes a replayed delivery across all of its messages', async () => {
    const { app, sent } = mk()
    const h = { 'x-github-event': 'issues', 'x-github-delivery': 'same' }
    await post(app, issueOpened, h)
    await post(app, issueOpened, h)
    await vi.waitFor(() => expect(sent.length).toBe(2)) // 2 from the first delivery only
  })
})
