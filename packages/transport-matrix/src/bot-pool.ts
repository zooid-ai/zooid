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
}

export class BotPool {
  constructor(
    private readonly client: Pick<
      MatrixClient,
      'registerBot' | 'joinRoom' | 'resolveAlias' | 'createRoom' | 'sendStateEvent' | 'setDisplayName'
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
      for (let i = 0; i < a.rooms.length; i++) {
        const room = a.rooms[i]
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
                resolved = await this.client.createRoom({
                  roomAliasName: aliasLocalpart,
                  invite: opts.adminUserId ? [opts.adminUserId] : [],
                  senderUserId: sender,
                  name: aliasLocalpart,
                  ...(opts.spaceRoomId ? { restrictedToSpaceId: opts.spaceRoomId } : {}),
                })
              }
              aliasToId.set(room, resolved)
            }
          }
          // Store the canonical room_id on the binding so the router (which
          // matches on event.room_id) sees a hit when Tuwunel pushes events.
          a.rooms[i] = resolved
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
