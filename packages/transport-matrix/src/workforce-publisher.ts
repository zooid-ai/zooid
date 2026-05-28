import { MatrixClient } from './matrix-client.js'
import type { AgentBinding } from './router.js'

export interface WorkforceRoster {
  version: 1
  agents: { user_id: string; name: string; rooms: string[] }[]
}

export function buildWorkforceRoster(agents: AgentBinding[]): WorkforceRoster {
  return {
    version: 1,
    agents: agents.map((a) => ({
      user_id: a.userId,
      name: a.name,
      rooms: a.rooms.map((r) => r.alias),
    })),
  }
}

export interface PublishOpts {
  client: MatrixClient
  spaceRoomId: string
  asUserId: string
  agents: AgentBinding[]
}

export async function publishWorkforce(opts: PublishOpts): Promise<void> {
  await opts.client.sendStateEvent({
    roomId: opts.spaceRoomId,
    asUserId: opts.asUserId,
    eventType: 'eco.zoon.workforce',
    stateKey: '',
    content: buildWorkforceRoster(opts.agents) as unknown as Record<string, unknown>,
  })
}

export interface PublisherHandle {
  reload(): Promise<void>
  stop(): Promise<void>
}

export interface StartOpts {
  client: MatrixClient
  spaceRoomId: string
  asUserId: string
  getAgents: () => AgentBinding[]
}

export async function startWorkforcePublisher(opts: StartOpts): Promise<PublisherHandle> {
  await publishWorkforce({ ...opts, agents: opts.getAgents() })
  return {
    async reload() {
      await publishWorkforce({ ...opts, agents: opts.getAgents() })
    },
    async stop() {},
  }
}
