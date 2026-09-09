import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifySignature, verifyCustomSignature, type CustomVerifierInput } from './webhook-verify.js'

const secret = 'shh'
const body = '{"action":"closed","number":42}'

const githubSig = (b = body, s = secret) =>
  `sha256=${createHmac('sha256', s).update(b).digest('hex')}`

describe('verifySignature — github', () => {
  it('accepts a correct signature over the raw body', () => {
    expect(
      verifySignature('github', { rawBody: body, headers: { 'x-hub-signature-256': githubSig() }, secret }),
    ).toEqual({ ok: true })
  })

  it('rejects a signature computed over different bytes', () => {
    expect(
      verifySignature('github', {
        rawBody: '{"action":"opened","number":42}',
        headers: { 'x-hub-signature-256': githubSig() },
        secret,
      }).ok,
    ).toBe(false)
  })

  it('rejects a signature made with a different secret', () => {
    expect(
      verifySignature('github', {
        rawBody: body,
        headers: { 'x-hub-signature-256': githubSig(body, 'wrong') },
        secret,
      }).ok,
    ).toBe(false)
  })

  it('rejects a missing signature header — fail closed', () => {
    expect(verifySignature('github', { rawBody: body, headers: {}, secret }).ok).toBe(false)
  })

  it('rejects a malformed header without throwing', () => {
    for (const h of ['', 'sha256=', 'garbage', 'sha256=zzzz', 'sha1=abcd']) {
      expect(() =>
        verifySignature('github', { rawBody: body, headers: { 'x-hub-signature-256': h }, secret }),
      ).not.toThrow()
      expect(
        verifySignature('github', { rawBody: body, headers: { 'x-hub-signature-256': h }, secret }).ok,
      ).toBe(false)
    }
  })

  it('rejects a signature of the wrong length without throwing (timingSafeEqual throws on length mismatch)', () => {
    expect(
      verifySignature('github', {
        rawBody: body,
        headers: { 'x-hub-signature-256': 'sha256=abcd' },
        secret,
      }).ok,
    ).toBe(false)
  })
})

describe('verifyCustomSignature', () => {
  const shopifyish = ({ rawBody, headers, secret: sec }: CustomVerifierInput) => {
    const expected = createHmac('sha256', sec).update(rawBody).digest('base64')
    return { ok: headers['x-shopify-hmac-sha256'] === expected, deliveryId: headers['x-delivery'] }
  }
  const input = (headers: Record<string, string>) => ({ rawBody: body, headers, secret })
  const sigOf = (b = body, s = secret) => createHmac('sha256', s).update(b).digest('base64')

  it('accepts what the operator function accepts, and passes back its delivery id', async () => {
    expect(
      await verifyCustomSignature(shopifyish, input({ 'x-shopify-hmac-sha256': sigOf(), 'x-delivery': 'd9' })),
    ).toEqual({ ok: true, deliveryId: 'd9' })
  })

  it('rejects what the operator function rejects', async () => {
    expect(
      (await verifyCustomSignature(shopifyish, input({ 'x-shopify-hmac-sha256': sigOf(body, 'wrong') }))).ok,
    ).toBe(false)
  })

  it('accepts a verifier that returns a bare boolean', async () => {
    expect(await verifyCustomSignature(() => true, input({}))).toEqual({ ok: true })
    expect(await verifyCustomSignature(() => false, input({}))).toEqual({ ok: false })
  })

  it('awaits an async verifier', async () => {
    expect(await verifyCustomSignature(async () => ({ ok: true, deliveryId: 'a1' }), input({}))).toEqual({
      ok: true,
      deliveryId: 'a1',
    })
  })

  it('fails closed when no verifier is loaded — never "no verifier, so accept"', async () => {
    expect(await verifyCustomSignature(undefined, input({}))).toEqual({ ok: false })
  })

  it('fails closed when the verifier throws or rejects', async () => {
    expect(
      (
        await verifyCustomSignature(() => {
          throw new Error('boom')
        }, input({}))
      ).ok,
    ).toBe(false)
    expect((await verifyCustomSignature(async () => Promise.reject(new Error('boom')), input({}))).ok).toBe(
      false,
    )
  })

  it('fails closed on a junk return value, rather than coercing it to true', async () => {
    for (const junk of ['yes', 1, {}, { ok: 'true' }, null, undefined]) {
      expect((await verifyCustomSignature((() => junk) as never, input({}))).ok).toBe(false)
    }
  })
})

describe('verifySignature — providers with a timestamp', () => {
  const slackSig = (ts: string, b = body, s = secret) =>
    `v0=${createHmac('sha256', s).update(`v0:${ts}:${b}`).digest('hex')}`

  it('accepts a fresh slack signature over v0:ts:body', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    expect(
      verifySignature('slack', {
        rawBody: body,
        headers: { 'x-slack-signature': slackSig(ts), 'x-slack-request-timestamp': ts },
        secret,
      }),
    ).toEqual({ ok: true })
  })

  it('rejects a slack signature outside the freshness window — replay defence', () => {
    const old = String(Math.floor(Date.now() / 1000) - 60 * 60)
    expect(
      verifySignature('slack', {
        rawBody: body,
        headers: { 'x-slack-signature': slackSig(old), 'x-slack-request-timestamp': old },
        secret,
      }).ok,
    ).toBe(false)
  })

  it('rejects a slack request with no timestamp header', () => {
    expect(
      verifySignature('slack', {
        rawBody: body,
        headers: { 'x-slack-signature': slackSig('123') },
        secret,
      }).ok,
    ).toBe(false)
  })
})
