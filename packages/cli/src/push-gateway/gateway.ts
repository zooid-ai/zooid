import { Hono } from 'hono'
import webpush from 'web-push'
import { buildPushPayload, ZOOID_APP_ID } from './payload.js'
import type { PushNotification } from './types.js'
import type { VapidKeys } from './vapid.js'

export interface PushGatewayOpts {
  keys: VapidKeys
  /** VAPID `sub` claim — a mailto: or https: the push service can complain to. */
  subject: string
}

function parseNotifyBody(raw: unknown): PushNotification | null {
  if (!raw || typeof raw !== 'object') return null
  const notification = (raw as { notification?: unknown }).notification
  if (!notification || typeof notification !== 'object') return null
  const n = notification as Record<string, unknown>
  if (typeof n.event_id !== 'string' || typeof n.room_id !== 'string' || typeof n.type !== 'string')
    return null
  if (!Array.isArray(n.devices)) return null
  return n as unknown as PushNotification
}

export function pushGateway(opts: PushGatewayOpts): Hono {
  const app = new Hono()

  app.post('/_matrix/push/v1/notify', async (c) => {
    const parsed = parseNotifyBody(await c.req.json().catch(() => null))
    if (!parsed) return c.json({ error: 'malformed notification' }, 400)

    const rejected: string[] = []
    await Promise.all(
      parsed.devices.map(async (device) => {
        // An app_id we don't own belongs to some other client sharing this
        // gateway URL. Skipping is mandatory: naming it in `rejected` makes the
        // homeserver PERMANENTLY DELETE that client's pusher (spec §4).
        if (device.app_id !== ZOOID_APP_ID) return
        const endpoint = device.data?.endpoint
        const auth = device.data?.auth
        if (typeof endpoint !== 'string' || typeof auth !== 'string') return

        try {
          await webpush.sendNotification(
            { endpoint, keys: { p256dh: device.pushkey, auth } },
            JSON.stringify(buildPushPayload(parsed, device)),
            {
              vapidDetails: { subject: opts.subject, ...opts.keys },
              TTL: 60 * 60 * 12,
              urgency: device.tweaks?.sound !== undefined ? 'high' : 'normal',
            },
          )
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode
          // 404/410 are the ONLY statuses that mean "this device is gone".
          // 429 and 5xx are transient; rejecting on those deletes live pushers.
          if (status === 404 || status === 410) rejected.push(device.pushkey)
          else console.warn(`[push] delivery to ${device.pushkey} failed (${status ?? '?'}):`, err)
        }
      }),
    )

    return c.json({ rejected })
  })

  return app
}
