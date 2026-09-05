import type { Hono } from 'hono'
import { pushGateway } from './gateway.js'
import { loadOrCreateVapidKeys } from './vapid.js'

export interface MountPushGatewayOpts {
  /** Directory the VAPID keypair is persisted under (`<dataDir>/vapid.json`). */
  dataDir: string
  /** VAPID `sub` claim — a mailto: or https: the push service can complain to. */
  subject: string
}

/** Mount the push gateway's routes onto an existing Hono app. */
export function mountPushGateway(app: Hono, opts: MountPushGatewayOpts): { publicKey: string } {
  const keys = loadOrCreateVapidKeys(opts.dataDir)
  app.route('/', pushGateway({ keys, subject: opts.subject }))
  return { publicKey: keys.publicKey }
}
