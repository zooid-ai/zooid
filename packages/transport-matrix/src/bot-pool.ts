import type { MatrixClient } from './matrix-client.js'
import type { AgentBinding } from './router.js'
import { serverNameFromMxid } from './space-provisioner.js'

export interface BootstrapOpts {
  /** Invited to any newly-created room; absent = no invite. */
  adminUserId?: string
  /** Workforce space room ID. When set, every resolved agent room is attached as m.space.child. */
  spaceRoomId?: string
  /** AS bot user ID. Required when spaceRoomId is set; sender of the m.space.child write. */
  asUserId?: string
  /**
   * Operator MXIDs seeded at PL 100 in every agent room this pool creates.
   * Applied via `power_level_content_override.users` at room creation only —
   * never reconciled. Empty/absent = no operator entries.
   */
  adminUserIds?: string[]
}

export class BotPool {
  constructor(
    private readonly client: Pick<
      MatrixClient,
      | 'registerBot'
      | 'invite'
      | 'joinRoom'
      | 'resolveAlias'
      | 'createRoom'
      | 'sendStateEvent'
      | 'setDisplayName'
    >,
    private readonly agents: AgentBinding[],
  ) {}

  async bootstrap(opts: BootstrapOpts = {}): Promise<void> {
    const aliasToId = new Map<string, string>()
    const attachedToSpace = new Set<string>()
    for (const a of this.agents) {
      const lp = localpart(a.userId)
      try {
        await this.client.registerBot(lp)
      } catch (err) {
        console.warn(`[matrix] register failed for ${a.userId}: ${(err as Error).message}`)
      }
      try {
        await this.client.setDisplayName(a.userId, a.displayName ?? lp)
      } catch (err) {
        console.warn(`[matrix] setDisplayName(${a.userId}) failed: ${(err as Error).message}`)
      }
      // Make each agent a member of the workforce space. That covers two
      // things at once: the dev.zooid.workforce roster is now backed by
      // actual space membership (so the Zoon client's member autocomplete
      // works across rooms), and every restricted child room's allow rule
      // is satisfied without per-room invites.
      if (opts.spaceRoomId && opts.asUserId) {
        try {
          await this.client.invite({
            roomId: opts.spaceRoomId,
            asUserId: opts.asUserId,
            targetUserId: a.userId,
          })
          await this.client.joinRoom(opts.spaceRoomId, a.userId)
        } catch (err) {
          console.warn(
            `[matrix] space membership for ${a.userId} failed: ${(err as Error).message}`,
          )
        }
      }
      for (let i = 0; i < a.rooms.length; i++) {
        const binding = a.rooms[i]!
        const room = binding.alias
        try {
          let resolved = room
          if (room.startsWith('#')) {
            const cached = aliasToId.get(room)
            if (cached) {
              resolved = cached
            } else {
              const existing = await this.client.resolveAlias(room)
              if (existing) {
                resolved = existing
              } else {
                const colon = room.indexOf(':')
                const aliasLocalpart = colon > 1 ? room.slice(1, colon) : room.slice(1)
                const sender = opts.adminUserId ?? a.userId
                const userPowerLevels = buildUserPowerLevels(
                  opts.asUserId,
                  opts.adminUserIds,
                  this.agents,
                  room,
                )
                resolved = await this.client.createRoom({
                  roomAliasName: aliasLocalpart,
                  invite: opts.adminUserId ? [opts.adminUserId] : [],
                  senderUserId: sender,
                  name: aliasLocalpart,
                  ...(opts.spaceRoomId ? { restrictedToSpaceId: opts.spaceRoomId } : {}),
                  ...(userPowerLevels ? { userPowerLevels } : {}),
                })
              }
              aliasToId.set(room, resolved)
            }
          }
          // Rewrite the binding's alias to the canonical room ID so the
          // router (which matches on event.room_id) sees a hit when Tuwunel
          // pushes events. The declared powerLevel was a creation-time
          // seed — it has no role after bootstrap.
          binding.alias = resolved
          await this.client.joinRoom(resolved, a.userId)

          if (
            opts.spaceRoomId &&
            opts.asUserId &&
            !attachedToSpace.has(resolved)
          ) {
            attachedToSpace.add(resolved)
            const via = serverNameFromMxid(a.userId)
            try {
              await this.client.sendStateEvent({
                roomId: opts.spaceRoomId,
                asUserId: opts.asUserId,
                eventType: 'm.space.child',
                stateKey: resolved,
                content: { via: [via] },
              })
            } catch (err) {
              console.warn(
                `[matrix] m.space.child(${resolved}) failed: ${(err as Error).message}`,
              )
            }
          }
        } catch (err) {
          console.warn(
            `[matrix] join failed (${a.userId} → ${room}): ${(err as Error).message}`,
          )
        }
      }
    }
  }

  findByUserId(userId: string): AgentBinding | undefined {
    return this.agents.find((a) => a.userId === userId)
  }

  findByName(name: string): AgentBinding | undefined {
    return this.agents.find((a) => a.name === name)
  }
}

function localpart(userId: string): string {
  const m = /^@([^:]+):/.exec(userId)
  if (!m) throw new Error(`bad user id: ${userId}`)
  return m[1]
}

/**
 * Build the `userPowerLevels` map for a room about to be created. Always
 * seeds the AS bot (when known) and any operator admins at PL 100; layers
 * per-agent declared PLs on top so agents land at moderator (or whatever
 * they declared) without a follow-up state write. Returns undefined when
 * the map would be empty — `createRoom` then omits the override entirely
 * and the preset's defaults apply.
 */
function buildUserPowerLevels(
  asUserId: string | undefined,
  admins: string[] | undefined,
  agents: AgentBinding[],
  roomAlias: string,
): Record<string, number> | undefined {
  const users: Record<string, number> = {}
  if (asUserId) users[asUserId] = 100
  if (admins) for (const a of admins) users[a] = 100
  for (const a of agents) {
    for (const r of a.rooms) {
      if (r.alias !== roomAlias) continue
      if (r.powerLevel !== undefined) users[a.userId] = r.powerLevel
    }
  }
  return Object.keys(users).length > 0 ? users : undefined
}
