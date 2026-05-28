import { MatrixClient } from './matrix-client.js'

export interface EnsureSpaceOpts {
  client: MatrixClient
  asUserId: string
  serverName: string
  spaceLocalpart: string
  preset: 'public_chat' | 'private_chat'
  /**
   * Operator MXIDs to seed at PL 100 in the space's `m.room.power_levels`
   * at creation. The AS bot is always included. Empty/absent → no override
   * (the preset's PL defaults apply). Only consulted on first creation —
   * if the alias already resolves we return the existing room untouched.
   */
  admins?: string[]
}

export async function ensureWorkforceSpace(opts: EnsureSpaceOpts): Promise<string> {
  const alias = `#${opts.spaceLocalpart}:${opts.serverName}`
  const existing = await opts.client.resolveAlias(alias)
  if (existing) return existing

  const display = opts.spaceLocalpart.charAt(0).toUpperCase() + opts.spaceLocalpart.slice(1)
  const body: Record<string, unknown> = {
    room_alias_name: opts.spaceLocalpart,
    name: display,
    preset: opts.preset,
    creation_content: { type: 'm.space' },
    // A workspace is joined by invitation, not self-service. Pin the space's
    // join rule to invite regardless of preset so it can't be walked into
    // (which would otherwise satisfy every restricted child room's allow).
    initial_state: [{ type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } }],
  }
  if (opts.admins && opts.admins.length > 0) {
    const users: Record<string, number> = { [opts.asUserId]: 100 }
    for (const a of opts.admins) users[a] = 100
    body.power_level_content_override = { users }
  }
  return opts.client.createRoomRaw({ asUserId: opts.asUserId, body })
}

export interface EnsureDefaultChannelOpts {
  client: MatrixClient
  asUserId: string
  serverName: string
  spaceId: string
  /** Localpart of the default channel; defaults to `general`. */
  channelLocalpart?: string
}

/**
 * Ensure a space has a default channel (`#general` by default), restricted to
 * the space's members and attached as an `m.space.child`. Idempotent: returns
 * the existing room if the alias already resolves. Has no agent — it's the
 * human landing room, so it is created here at provisioning time rather than
 * via the agent-room path.
 */
export async function ensureDefaultChannel(opts: EnsureDefaultChannelOpts): Promise<string> {
  const localpart = opts.channelLocalpart ?? 'general'
  const alias = `#${localpart}:${opts.serverName}`
  const existing = await opts.client.resolveAlias(alias)
  if (existing) return existing

  const roomId = await opts.client.createRoom({
    roomAliasName: localpart,
    invite: [],
    senderUserId: opts.asUserId,
    name: localpart.charAt(0).toUpperCase() + localpart.slice(1),
    restrictedToSpaceId: opts.spaceId,
  })
  await opts.client.sendStateEvent({
    roomId: opts.spaceId,
    asUserId: opts.asUserId,
    eventType: 'm.space.child',
    stateKey: roomId,
    content: { via: [opts.serverName] },
  })
  return roomId
}

export function serverNameFromMxid(mxid: string): string {
  const colon = mxid.indexOf(':')
  if (colon < 0) {
    throw new Error(`mxid lacks server: ${mxid}`)
  }
  return mxid.slice(colon + 1)
}
