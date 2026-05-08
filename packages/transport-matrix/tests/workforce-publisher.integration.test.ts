import { describe, expect, it, vi } from 'vitest'
import { MatrixClient } from '../src/matrix-client.js'
import { startWorkforcePublisher } from '../src/workforce-publisher.js'
import type { AgentBinding } from '../src/router.js'

describe('startWorkforcePublisher (integration)', () => {
  it('publishes once on start and again when reload() is called', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
    const client = new MatrixClient({
      homeserver: 'https://hs.zoon.local',
      asToken: 't',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })

    const initial: AgentBinding[] = [
      { name: 'planner', userId: '@planner:zoon.local', rooms: [], trigger: 'mention' },
    ]
    let agents = initial
    const handle = await startWorkforcePublisher({
      client,
      spaceRoomId: '!space:zoon.local',
      asUserId: '@zooid:zoon.local',
      getAgents: () => agents,
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    let body = JSON.parse(fetch.mock.calls[0]![1]!.body as string)
    expect(body.agents).toHaveLength(1)

    agents = [
      ...initial,
      { name: 'reviewer', userId: '@reviewer:zoon.local', rooms: [], trigger: 'any' },
    ]
    await handle.reload()
    expect(fetch).toHaveBeenCalledTimes(2)
    body = JSON.parse(fetch.mock.calls[1]![1]!.body as string)
    expect(body.agents.map((a: { name: string }) => a.name)).toEqual(['planner', 'reviewer'])

    await handle.stop()
  })
})
