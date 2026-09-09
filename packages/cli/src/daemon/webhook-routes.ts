import type { Context, Hono } from 'hono'
import type { MatchContext, TriggerConfig, WebhookTriggerConfig } from '@zooid/core'
import { evaluateMatch, renderTemplate } from '@zooid/core'
import { fireTrigger, type FireTriggerDeps } from './trigger-runner.js'
import { verifySignature, verifyCustomSignature, type CustomVerifier } from './webhook-verify.js'
import { DeliveryCache } from './delivery-cache.js'

// GitHub's delivery times out at 10s; a 1MB cap leaves headroom to hash and
// respond well inside that even on a slow box. Checked before hashing, per
// [[ZOD082]] §Design 4 rule 5.
const MAX_BODY = 1_000_000
// `${output}` is a chat message body, not a blob store — cap it well under
// Matrix's ~64KiB event-size ceiling once the surrounding `text:` is added.
const MAX_OUTPUT_CHARS = 60_000
const TRUNCATION_MARKER = '\n\n… (truncated)'
// Comfortably past any provider's redelivery window.
const DELIVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000

const EVENT_HEADER_BY_PROVIDER: Partial<Record<WebhookTriggerConfig['provider'], string>> = {
  github: 'x-github-event',
}

const DELIVERY_ID_HEADER_BY_PROVIDER: Partial<Record<WebhookTriggerConfig['provider'], string>> = {
  github: 'x-github-delivery',
  standard: 'webhook-id',
}

// Headers any supported provider might send, gathered once per request.
const RELEVANT_HEADERS = [
  'x-hub-signature-256',
  'x-github-event',
  'x-github-delivery',
  'stripe-signature',
  'x-slack-signature',
  'x-slack-request-timestamp',
  'webhook-signature',
  'webhook-id',
  'webhook-timestamp',
] as const

export interface WebhookDeps {
  triggers: Record<string, TriggerConfig>
  /**
   * Verifier function per `provider: custom` trigger name, imported at
   * daemon start by `loadCustomVerifiers`. A custom trigger with no entry
   * here rejects every delivery — fail closed.
   */
  customVerifiers?: Record<string, CustomVerifier>
  agentUserIds: Record<string, string>
  resolveRoom: FireTriggerDeps['resolveRoom']
  ensureBot: FireTriggerDeps['ensureBot']
  sendMessage: FireTriggerDeps['sendMessage']
}

/**
 * Gather the headers verification might need. Named providers read a fixed
 * set; `provider: custom` gets every header, lower-cased, since only the
 * operator's verifier knows which ones its service sends.
 */
function headersOf(
  c: { req: { header: (name: string) => string | undefined; raw: Request } },
  all: boolean,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  if (all) {
    c.req.raw.headers.forEach((value, key) => {
      out[key.toLowerCase()] = value
    })
    return out
  }
  for (const h of RELEVANT_HEADERS) out[h] = c.req.header(h)
  return out
}

/** Headers as a dense record, for handing to an operator's verifier. */
function definedHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

function renderPayload(raw: string): string {
  let pretty: string
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    pretty = raw
  }
  if (pretty.length <= MAX_OUTPUT_CHARS) return pretty
  return pretty.slice(0, MAX_OUTPUT_CHARS) + TRUNCATION_MARKER
}

async function handleDelivery(
  deps: WebhookDeps,
  name: string,
  trigger: TriggerConfig,
  raw: string,
  headers: Record<string, string | undefined>,
  cache: DeliveryCache,
  customDeliveryId: string | undefined,
): Promise<void> {
  try {
    const webhook = trigger.webhook
    if (!webhook) return

    const idHeader = DELIVERY_ID_HEADER_BY_PROVIDER[webhook.provider]
    // A custom verifier reports its own delivery id, since only it knows
    // where the service puts one.
    const deliveryId = customDeliveryId ?? (idHeader ? headers[idHeader] : undefined)
    if (deliveryId !== undefined && cache.seen(`${name}:${deliveryId}`)) return

    const eventHeader = EVENT_HEADER_BY_PROVIDER[webhook.provider]
    const event = eventHeader ? headers[eventHeader] : undefined

    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      body = undefined
    }

    const ctx: MatchContext = {
      event,
      body,
      headers: definedHeaders(headers),
      output: renderPayload(raw),
    }

    for (const message of trigger.messages) {
      if (message.match !== undefined && !evaluateMatch(message.match, ctx)) continue

      const agentUserId = deps.agentUserIds[message.mention]
      if (!agentUserId) {
        console.warn(`[webhook:${name}] unknown agent "${message.mention}" — skipping`)
        continue
      }

      await fireTrigger({
        name,
        as: trigger.as,
        message: { ...message, text: renderTemplate(message.text, ctx) },
        agentUserId,
        resolveRoom: deps.resolveRoom,
        ensureBot: deps.ensureBot,
        sendMessage: deps.sendMessage,
      })
    }
  } catch (err) {
    // Never throw: the response has already been sent, and one bad delivery
    // must not take down the daemon.
    console.warn(`[webhook:${name}] failed:`, (err as Error).message)
  }
}

export const WEBHOOK_ROUTE_PREFIX = '/_zooid/webhooks'

export function mountWebhookRoutes(app: Hono, deps: WebhookDeps): void {
  const cache = new DeliveryCache(DELIVERY_CACHE_TTL_MS)

  const receive = async (c: Context<any, '/:name'>) => {
    const name = c.req.param('name')
    const trigger = deps.triggers[name]

    // Read the RAW body first. Parsing and re-serializing changes the bytes
    // and breaks every signature — the classic webhook bug.
    const raw = await c.req.text()
    if (raw.length > MAX_BODY) return c.text('too large', 413)

    // Unknown trigger and bad signature return the identical response, so
    // the endpoint cannot be probed to discover which triggers exist.
    if (!trigger?.webhook) return c.text('unauthorized', 401)
    const webhook = trigger.webhook
    const headers = headersOf(c, webhook.provider === 'custom')

    let customDeliveryId: string | undefined
    if (webhook.provider === 'custom') {
      const v = await verifyCustomSignature(deps.customVerifiers?.[name], {
        rawBody: raw,
        headers: definedHeaders(headers),
        secret: webhook.secret,
      })
      if (!v.ok) return c.text('unauthorized', 401)
      customDeliveryId = v.deliveryId
    } else {
      const v = verifySignature(webhook.provider, {
        rawBody: raw,
        headers,
        secret: webhook.secret,
      })
      if (!v.ok) return c.text('unauthorized', 401)
    }

    // Accepted. Everything below is fire-and-forget: GitHub times out at
    // 10s and an agent turn does not fit in that.
    void handleDelivery(deps, name, trigger, raw, headers, cache, customDeliveryId)
    return c.text('accepted', 202)
  }

  app.post(`${WEBHOOK_ROUTE_PREFIX}/:name`, receive)
}
