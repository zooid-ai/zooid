import type { PushDevice, PushNotification, PushPayload } from './types.js'

export const MAX_BODY = 140
export const ZOOID_APP_ID = 'dev.zooid.web'

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * Trim a homeserver notification down to what the service worker renders.
 *
 * Full content, not `event_id_only`: rooms are unencrypted, so the homeserver
 * already holds plaintext and the gateway is ours. `event_id_only` would force
 * the worker to hold an access token and fetch each event before it could show
 * anything (spec §7). RFC 8291 means the browser vendor sees ciphertext either
 * way.
 */
export function buildPushPayload(n: PushNotification, device?: PushDevice): PushPayload {
  const body =
    typeof n.content?.body === 'string' ? truncate(n.content.body as string, MAX_BODY) : undefined
  return {
    event_id: n.event_id,
    room_id: n.room_id,
    room_name: n.room_name ?? n.room_id,
    ...(n.sender_display_name !== undefined ? { sender_display_name: n.sender_display_name } : {}),
    type: n.type,
    ...(body !== undefined ? { body } : {}),
    unread: n.counts?.unread ?? 0,
    // Whether this makes a noise is a push-rule property the server evaluated,
    // not a second decision made here (spec §12).
    sound: device?.tweaks?.sound !== undefined,
  }
}
