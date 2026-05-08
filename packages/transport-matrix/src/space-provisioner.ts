import { MatrixClient } from './matrix-client.js'

export interface EnsureSpaceOpts {
  client: MatrixClient
  asUserId: string
  serverName: string
  spaceLocalpart: string
  preset: 'public_chat' | 'private_chat'
}

export async function ensureWorkforceSpace(opts: EnsureSpaceOpts): Promise<string> {
  const alias = `#${opts.spaceLocalpart}:${opts.serverName}`
  const existing = await opts.client.resolveAlias(alias)
  if (existing) return existing

  const display = opts.spaceLocalpart.charAt(0).toUpperCase() + opts.spaceLocalpart.slice(1)
  return opts.client.createRoomRaw({
    asUserId: opts.asUserId,
    body: {
      room_alias_name: opts.spaceLocalpart,
      name: display,
      preset: opts.preset,
      creation_content: { type: 'm.space' },
    },
  })
}

export function serverNameFromMxid(mxid: string): string {
  const colon = mxid.indexOf(':')
  if (colon < 0) {
    throw new Error(`mxid lacks server: ${mxid}`)
  }
  return mxid.slice(colon + 1)
}
