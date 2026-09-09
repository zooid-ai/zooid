import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { loadZooidConfig } from '@zooid/core'
import { mountWebhookRoutes } from './webhook-routes.js'

const secret = 'route-secret'
const body = JSON.stringify({ action: 'opened' })
const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
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
    matrix: { rooms: ['#product:example.org'] }
triggers:
  triage:
    webhook:
      provider: github
      secret: ${secret}
    as: '@hook:example.org'
    room: '!product:example.org'
    mention: product
    text: Triage.
`

function makeApp() {
  const sent: Array<Record<string, unknown>> = []
  const app = new Hono()
  mountWebhookRoutes(app, {
    triggers: loadZooidConfig(yaml).triggers,
    agentUserIds: { product: '@product:example.org' },
    resolveRoom: async (room) => room,
    ensureBot: async () => {},
    sendMessage: async (message: Record<string, unknown>) => {
      sent.push(message)
      return { event_id: '$event' }
    },
  })
  return { app, sent }
}

function post(app: Hono, path: string) {
  return app.request(path, {
    method: 'POST',
    body,
    headers: {
      'x-hub-signature-256': signature,
      'x-github-event': 'issues',
      'x-github-delivery': crypto.randomUUID(),
    },
  })
}

describe('webhook route contract', () => {
  it('accepts a signed delivery at /_zooid/webhooks/:name', async () => {
    const { app, sent } = makeApp()
    expect((await post(app, '/_zooid/webhooks/triage')).status).toBe(202)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
  })

  it('does not expose the retired /webhook/:name route', async () => {
    const { app, sent } = makeApp()
    expect((await post(app, '/webhook/triage')).status).toBe(404)
    expect(sent).toHaveLength(0)
  })
})
