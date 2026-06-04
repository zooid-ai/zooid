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
  /**
   * Join rule pinned on the space at creation. Defaults to `invite`: a
   * workspace is joined by invitation, not self-service, so it can't be walked
   * into (which would otherwise satisfy every restricted child room's `allow`).
   * `zooid dev` passes `public` so a self-service-registered local account can
   * join `#<space>` straight from the web client without an invite — acceptable
   * because the dev homeserver is local-only and never deployed.
   */
  joinRule?: 'invite' | 'public'
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
    // Pin the join rule regardless of preset. Defaults to invite so the space
    // can't be walked into (which would otherwise satisfy every restricted
    // child room's allow); `zooid dev` opts into `public` for local-only use.
    initial_state: [
      { type: 'm.room.join_rules', state_key: '', content: { join_rule: opts.joinRule ?? 'invite' } },
    ],
  }
  if (opts.admins && opts.admins.length > 0) {
    // Invite each admin so they actually become members — PL 100 alone does
    // not grant membership in an invite-only space.
    body.invite = opts.admins
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
  /**
   * Operator MXIDs to seed at PL 100 in the channel's `m.room.power_levels`
   * at creation. The AS bot is always included. Empty/absent → no override
   * (the preset's PL defaults apply). Only consulted on first creation —
   * if the alias already resolves we return the existing room untouched.
   */
  admins?: string[]
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

  let userPowerLevels: Record<string, number> | undefined
  if (opts.admins && opts.admins.length > 0) {
    userPowerLevels = { [opts.asUserId]: 100 }
    for (const a of opts.admins) userPowerLevels[a] = 100
  }

  const roomId = await opts.client.createRoom({
    roomAliasName: localpart,
    invite: [],
    senderUserId: opts.asUserId,
    name: localpart.charAt(0).toUpperCase() + localpart.slice(1),
    restrictedToSpaceId: opts.spaceId,
    ...(userPowerLevels ? { userPowerLevels } : {}),
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
