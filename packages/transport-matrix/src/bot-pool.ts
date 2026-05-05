import type { MatrixClient } from './matrix-client.js'
import type { AgentBinding } from './router.js'

export interface BootstrapOpts {
  /** Invited to any newly-created room; absent = no invite. */
  adminUserId?: string
}

export class BotPool {
  constructor(
    private readonly client: Pick<
      MatrixClient,
      'registerBot' | 'joinRoom' | 'resolveAlias' | 'createRoom'
    >,
    private readonly agents: AgentBinding[],
  ) {}

  async bootstrap(opts: BootstrapOpts = {}): Promise<void> {
    const aliasToId = new Map<string, string>()
    for (const a of this.agents) {
      try {
        await this.client.registerBot(localpart(a.userId))
      } catch (err) {
        console.warn(`[matrix] register failed for ${a.userId}: ${(err as Error).message}`)
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
                })
              }
              aliasToId.set(room, resolved)
            }
          }
          // Store the canonical room_id on the binding so the router (which
          // matches on event.room_id) sees a hit when Tuwunel pushes events.
          a.rooms[i] = resolved
          await this.client.joinRoom(resolved, a.userId)
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
