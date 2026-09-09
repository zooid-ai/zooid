import { createHmac, timingSafeEqual } from 'node:crypto'
import type { WebhookTriggerConfig } from '@zooid/core'

const FRESHNESS_S = 300

/**
 * What an operator's `verify:` module is called with. `headers` carries every
 * request header, lower-cased — a named provider reads a fixed set, but a
 * custom verifier is the only thing that knows which ones its service sends.
 */
export interface CustomVerifierInput {
  rawBody: string
  headers: Record<string, string>
  secret: string
}

/**
 * An operator-supplied verifier. Returns a bare boolean, or a result that
 * also carries the provider's unique delivery id — the id is what replay
 * dedupe keys on, and only the verifier knows where the service puts it.
 * Throwing counts as rejection; nothing it does can turn into an accept.
 */
export type CustomVerifier = (
  input: CustomVerifierInput,
) =>
  | boolean
  | { ok: boolean; deliveryId?: string }
  | Promise<boolean | { ok: boolean; deliveryId?: string }>

/** Providers whose signing scheme is built in. `custom` is verified by the operator's own function. */
export type NamedProvider = Exclude<WebhookTriggerConfig['provider'], 'custom'>

export interface VerifyInput {
  rawBody: string
  headers: Record<string, string | undefined>
  secret: string
}

export type VerifyResult = { ok: true } | { ok: false }

// Length-check first: timingSafeEqual throws when buffers differ in length.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

function hmacHex(secret: string, baseString: string): string {
  return createHmac('sha256', secret).update(baseString).digest('hex')
}

function verifyGithub(input: VerifyInput): VerifyResult {
  const header = input.headers['x-hub-signature-256']
  if (!header) return { ok: false }
  const [scheme, sig] = header.split('=')
  if (scheme !== 'sha256' || !sig) return { ok: false }
  const expected = hmacHex(input.secret, input.rawBody)
  return safeEqual(sig, expected) ? { ok: true } : { ok: false }
}

function verifyStripe(input: VerifyInput): VerifyResult {
  const header = input.headers['stripe-signature']
  if (!header) return { ok: false }
  const parts = Object.fromEntries(
    header
      .split(',')
      .map((p) => p.split('=', 2) as [string, string | undefined])
      .filter(([, v]) => v !== undefined),
  )
  const ts = parts.t
  const sig = parts.v1
  if (!ts || !sig) return { ok: false }
  if (!isFresh(ts)) return { ok: false }
  const expected = hmacHex(input.secret, `${ts}.${input.rawBody}`)
  return safeEqual(sig, expected) ? { ok: true } : { ok: false }
}

function verifySlack(input: VerifyInput): VerifyResult {
  const header = input.headers['x-slack-signature']
  const ts = input.headers['x-slack-request-timestamp']
  if (!header || !ts) return { ok: false }
  if (!header.startsWith('v0=')) return { ok: false }
  const sig = header.slice('v0='.length)
  if (!isFresh(ts)) return { ok: false }
  const expected = hmacHex(input.secret, `v0:${ts}:${input.rawBody}`)
  return safeEqual(sig, expected) ? { ok: true } : { ok: false }
}

function verifyStandard(input: VerifyInput): VerifyResult {
  const header = input.headers['webhook-signature']
  const id = input.headers['webhook-id']
  const ts = input.headers['webhook-timestamp']
  if (!header || !id || !ts) return { ok: false }
  if (!isFresh(ts)) return { ok: false }
  const candidate = header
    .split(' ')
    .map((p) => (p.startsWith('v1,') ? p.slice('v1,'.length) : undefined))
    .find((v) => v !== undefined)
  if (!candidate) return { ok: false }
  const expected = createHmac('sha256', input.secret)
    .update(`${id}.${ts}.${input.rawBody}`)
    .digest('base64')
  return safeEqual(candidate, expected) ? { ok: true } : { ok: false }
}

function isFresh(tsRaw: string): boolean {
  const ts = Number(tsRaw)
  if (!Number.isFinite(ts)) return false
  const nowS = Date.now() / 1000
  return Math.abs(nowS - ts) <= FRESHNESS_S
}

const VERIFIERS: Record<NamedProvider, (input: VerifyInput) => VerifyResult> = {
  github: verifyGithub,
  stripe: verifyStripe,
  slack: verifySlack,
  standard: verifyStandard,
}

/**
 * Verify a webhook delivery's signature. Every failure path returns
 * `{ ok: false }` — nothing throws, and no reason is returned to the
 * caller, since the route must not explain *why* it rejected a request.
 */
export function verifySignature(provider: NamedProvider, input: VerifyInput): VerifyResult {
  try {
    return VERIFIERS[provider](input)
  } catch {
    return { ok: false }
  }
}

/**
 * Run an operator-supplied verifier for `provider: custom`. Fails closed on
 * every abnormal path — no verifier loaded, a throw, a rejected promise, or
 * a return value that is not a recognised shape. A verifier can only ever
 * *grant* acceptance by explicitly returning true.
 */
export async function verifyCustomSignature(
  verifier: CustomVerifier | undefined,
  input: CustomVerifierInput,
): Promise<{ ok: boolean; deliveryId?: string }> {
  if (typeof verifier !== 'function') return { ok: false }
  try {
    const result = await verifier(input)
    if (result === true) return { ok: true }
    if (result === false || result === null || typeof result !== 'object') return { ok: false }
    if (result.ok !== true) return { ok: false }
    return typeof result.deliveryId === 'string'
      ? { ok: true, deliveryId: result.deliveryId }
      : { ok: true }
  } catch {
    return { ok: false }
  }
}
