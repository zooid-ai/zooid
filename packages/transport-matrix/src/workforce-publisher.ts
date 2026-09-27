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
  /**
   * The workstation name. Each daemon sharing a space owns one state key, so
   * the space's `dev.zooid.workforce` events together form the whole roster
   * and no daemon's write can clobber another's. `''` without a workstation.
   */
  stateKey?: string
}

export async function publishWorkforce(opts: PublishOpts): Promise<void> {
  await opts.client.sendStateEvent({
    roomId: opts.spaceRoomId,
    asUserId: opts.asUserId,
    eventType: 'dev.zooid.workforce',
    stateKey: opts.stateKey ?? '',
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
  stateKey?: string
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

export interface WorkforceEntry {
  userId: string
  name: string
  workstation?: string
  rooms: string[]
}

/**
 * Every agent in the workforce across workstations: the union of the space's
 * `dev.zooid.workforce` state events, one per state key.
 */
export class WorkforceDirectory {
  private readonly rosters = new Map<string, WorkforceEntry[]>()
  readonly agentIds = new Set<string>()

  /** Seed from a space's full state (`GET /rooms/{id}/state`). */
  load(events: { type?: string; state_key?: string; content?: unknown }[]): void {
    for (const ev of events) {
      if (ev.type === 'dev.zooid.workforce' && ev.state_key !== undefined)
        this.apply(ev.state_key, ev.content)
    }
  }

  /** Replace one workstation's roster; empty content removes it. */
  apply(stateKey: string, content: unknown): void {
    const agents = (content as Partial<WorkforceRoster> | undefined)?.agents
    const entries: WorkforceEntry[] = Array.isArray(agents)
      ? agents
          .filter((a) => typeof a?.user_id === 'string')
          .map((a) => ({
            userId: a.user_id,
            name: typeof a.name === 'string' ? a.name : a.user_id,
            workstation: stateKey || undefined,
            rooms: Array.isArray(a.rooms) ? a.rooms.filter((r): r is string => typeof r === 'string') : [],
          }))
      : []
    if (entries.length > 0) this.rosters.set(stateKey, entries)
    else this.rosters.delete(stateKey)
    this.agentIds.clear()
    for (const list of this.rosters.values()) for (const e of list) this.agentIds.add(e.userId)
  }

  entries(): WorkforceEntry[] {
    return [...this.rosters.values()].flat()
  }

  nameOf(userId: string): string | undefined {
    return this.entries().find((e) => e.userId === userId)?.name
  }
}
