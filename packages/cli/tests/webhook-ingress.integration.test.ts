import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { createHmac } from 'node:crypto'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountWebhookRoutes } from '../src/daemon/webhook-routes.js'
import { loadCustomVerifiers } from '../src/daemon/load-custom-verifiers.js'
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
    matrix:
      rooms: ["#product:example.org"]
triggers:
  reconcile:
    webhook:
      provider: github
      event: pull_request
      secret: "${secret}"
    as: "@hook:example.org"
    room: "!product:example.org"
    mention: product
    text: |
      A PR merged.

      \${output}
`

const body = JSON.stringify({ action: 'closed', pull_request: { merged: true, number: 42 } })
const sign = (b: string, s = secret) =>
  `sha256=${createHmac('sha256', s).update(b).digest('hex')}`

const mk = () => {
  const sent: Array<Record<string, unknown>> = []
  const app = new Hono()
  mountWebhookRoutes(app, {
    triggers: loadZooidConfig(yaml).triggers,
    agentUserIds: { product: '@product:example.org' },
    resolveRoom: async (r: string) => r,
    ensureBot: async () => {},
    sendMessage: async (m: Record<string, unknown>) => {
      sent.push(m)
      return { event_id: '$1' }
    },
  })
  return { app, sent }
}

const post = (app: Hono, headers: Record<string, string>, b = body) =>
  app.request('/webhook/reconcile', { method: 'POST', body: b, headers })

/**
 * The custom provider is verified by the operator's own function, loaded
 * from disk at daemon start. Exercised end to end because the parts a unit
 * test cannot reach are the ones most likely to break: resolving the module
 * path, handing the verifier every request header, and keying replay dedupe
 * on the id the verifier reports.
 */
describe('webhook ingress — a custom provider', () => {
  const customYaml = yaml.replace(
    `      provider: github
      event: pull_request
      secret: "${secret}"`,
    `      provider: custom
      verify: ./__fixtures__/shopify-verifier.mjs
      secret: "${secret}"`,
  )

  const loadCustom = () =>
    loadZooidConfig(customYaml, { configDir: dirname(fileURLToPath(import.meta.url)) })

  const mkCustom = async () => {
    const sent: Array<Record<string, unknown>> = []
    const app = new Hono()
    const triggers = loadCustom().triggers
    mountWebhookRoutes(app, {
      triggers,
      customVerifiers: await loadCustomVerifiers(triggers),
      agentUserIds: { product: '@product:example.org' },
      resolveRoom: async (r: string) => r,
      ensureBot: async () => {},
      sendMessage: async (m: Record<string, unknown>) => {
        sent.push(m)
        return { event_id: '$1' }
      },
    })
    return { app, sent }
  }

  const b64 = (b: string, s = secret) => createHmac('sha256', s).update(b).digest('base64')
  const postCustom = (app: Hono, headers: Record<string, string>) =>
    app.request('/webhook/reconcile', { method: 'POST', body, headers })

  it('accepts what the operator verifier accepts, and posts into the room', async () => {
    const { app, sent } = await mkCustom()
    const res = await postCustom(app, {
      'x-shopify-hmac-sha256': b64(body),
      'x-shopify-delivery': 'c1',
    })
    expect(res.status).toBe(202)
    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(String((sent[0].content as Record<string, string>).body)).toContain('"number": 42')
  })

  it('rejects a bad signature with the same 401 as every other failure', async () => {
    const { app, sent } = await mkCustom()
    const res = await postCustom(app, { 'x-shopify-hmac-sha256': b64(body, 'wrong') })
    expect(res.status).toBe(401)
    expect(sent.length).toBe(0)
  })

  it('dedupes on the delivery id the verifier reports', async () => {
    const { app, sent } = await mkCustom()
    const h = { 'x-shopify-hmac-sha256': b64(body), 'x-shopify-delivery': 'same' }
    expect((await postCustom(app, h)).status).toBe(202)
    expect((await postCustom(app, h)).status).toBe(202)
    await vi.waitFor(() => expect(sent.length).toBe(1))
  })

  it('rejects every delivery when no verifier was loaded — fail closed', async () => {
    const app = new Hono()
    const sent: Array<Record<string, unknown>> = []
    mountWebhookRoutes(app, {
      triggers: loadCustom().triggers,
      // customVerifiers deliberately omitted, as if loading had been skipped.
      agentUserIds: { product: '@product:example.org' },
      resolveRoom: async (r: string) => r,
      ensureBot: async () => {},
      sendMessage: async (m: Record<string, unknown>) => {
        sent.push(m)
        return { event_id: '$1' }
      },
    })
    const res = await postCustom(app, { 'x-shopify-hmac-sha256': b64(body) })
    expect(res.status).toBe(401)
    expect(sent.length).toBe(0)
  })
})

describe('loadCustomVerifiers', () => {
  const withVerify = (path: string) =>
    yaml.replace(
      `      provider: github
      event: pull_request
      secret: "${secret}"`,
      `      provider: custom
      verify: ${path}
      secret: "${secret}"`,
    )
  const configDir = dirname(fileURLToPath(import.meta.url))

  it('fails fast on a path that does not resolve, naming the trigger', async () => {
    const cfg = loadZooidConfig(withVerify('./__fixtures__/nope.mjs'), { configDir })
    await expect(loadCustomVerifiers(cfg.triggers)).rejects.toThrow(
      /triggers\.reconcile\.webhook\.verify: cannot load .*nope\.mjs/,
    )
  })

  it('fails fast when the module exports no function', async () => {
    const cfg = loadZooidConfig(withVerify('./__fixtures__/not-a-verifier.mjs'), { configDir })
    await expect(loadCustomVerifiers(cfg.triggers)).rejects.toThrow(
      /must export a function as `default`/,
    )
  })

  it('ignores triggers that are not provider: custom', async () => {
    expect(await loadCustomVerifiers(loadZooidConfig(yaml).triggers)).toEqual({})
  })
})

describe('webhook ingress', () => {
  it('accepts a correctly signed delivery and posts into the room', async () => {
    const { app, sent } = mk()
    const res = await post(app, {
      'x-hub-signature-256': sign(body),
      'x-github-event': 'pull_request',
      'x-github-delivery': 'd1',
    })
    expect(res.status).toBe(202)
    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(sent[0].asUserId).toBe('@hook:example.org')
    expect((sent[0].content as Record<string, unknown>)['m.mentions']).toEqual({
      user_ids: ['@product:example.org'],
    })
    expect(String((sent[0].content as Record<string, string>).body)).toContain('A PR merged.')
    expect(String((sent[0].content as Record<string, string>).body)).toContain('"number": 42')
  })

  it('rejects a bad signature with 401 and posts nothing', async () => {
    const { app, sent } = mk()
    const res = await post(app, {
      'x-hub-signature-256': sign(body, 'wrong'),
      'x-github-delivery': 'd2',
    })
    expect(res.status).toBe(401)
    expect(sent.length).toBe(0)
  })

  it('returns the same 401 for an unknown trigger — the endpoint must not enumerate triggers', async () => {
    const { app } = mk()
    const unknown = await app.request('/webhook/does-not-exist', { method: 'POST', body })
    const badsig = await post(app, { 'x-hub-signature-256': sign(body, 'wrong') })
    expect(unknown.status).toBe(401)
    expect(badsig.status).toBe(401)
    expect(await unknown.text()).toBe(await badsig.text())
  })

  it('ignores a replayed delivery id', async () => {
    const { app, sent } = mk()
    const h = {
      'x-hub-signature-256': sign(body),
      'x-github-event': 'pull_request',
      'x-github-delivery': 'same',
    }
    expect((await post(app, h)).status).toBe(202)
    expect((await post(app, h)).status).toBe(202)
    await vi.waitFor(() => expect(sent.length).toBe(1))
  })

  it('rejects a body over the size cap before hashing it', async () => {
    const { app, sent } = mk()
    const huge = JSON.stringify({ pad: 'x'.repeat(2_000_000) })
    const res = await post(app, { 'x-hub-signature-256': sign(huge) }, huge)
    expect(res.status).toBe(413)
    expect(sent.length).toBe(0)
  })

  it('answers before the agent turn — the response must not wait on Matrix', async () => {
    const { app } = mk()
    let released: () => void = () => {}
    const gate = new Promise<void>((r) => (released = r))
    const slow = new Hono()
    mountWebhookRoutes(slow, {
      triggers: loadZooidConfig(yaml).triggers,
      agentUserIds: { product: '@product:example.org' },
      resolveRoom: async (r: string) => r,
      ensureBot: async () => {},
      sendMessage: async () => {
        await gate
        return { event_id: '$1' }
      },
    })
    const res = await slow.request('/webhook/reconcile', {
      method: 'POST',
      body,
      headers: { 'x-hub-signature-256': sign(body), 'x-github-delivery': 'd3' },
    })
    expect(res.status).toBe(202)
    released()
  })

  it('does not let payload content forge a mention (§Design 3)', async () => {
    const evil = JSON.stringify({ title: 'ping @product:example.org and @admin:example.org' })
    const { app, sent } = mk()
    await post(app, { 'x-hub-signature-256': sign(evil), 'x-github-delivery': 'd4' }, evil)
    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect((sent[0].content as Record<string, unknown>)['m.mentions']).toEqual({
      user_ids: ['@product:example.org'],
    })
  })

  it('truncates an oversized payload in the message body', async () => {
    const big = JSON.stringify({ notes: 'y'.repeat(100_000) })
    const { app, sent } = mk()
    await post(app, { 'x-hub-signature-256': sign(big), 'x-github-delivery': 'd5' }, big)
    await vi.waitFor(() => expect(sent.length).toBe(1))
    const text = String((sent[0].content as Record<string, string>).body)
    expect(text.length).toBeLessThan(70_000)
    expect(text).toContain('truncated')
  })
})
