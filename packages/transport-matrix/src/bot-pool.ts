import type { MatrixClient } from './matrix-client.js'
import type { AgentBinding } from './router.js'

export class BotPool {
  constructor(
    private readonly client: Pick<MatrixClient, 'registerBot' | 'joinRoom'>,
    private readonly agents: AgentBinding[],
  ) {}

  async bootstrap(): Promise<void> {
    for (const a of this.agents) {
      try {
        await this.client.registerBot(localpart(a.userId))
      } catch (err) {
        console.warn(`[matrix] register failed for ${a.userId}: ${(err as Error).message}`)
      }
      for (const room of a.rooms) {
        try {
          await this.client.joinRoom(room, a.userId)
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
