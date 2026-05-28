import { describe, expect, it, vi } from 'vitest'
import { BotPool } from '../src/bot-pool.js'
import { MatrixClient } from '../src/matrix-client.js'
import { ensureWorkforceSpace } from '../src/space-provisioner.js'
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

describe('BotPool + space provisioner (integration)', () => {
  it('attaches each agent room as m.space.child of the workforce space', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      // Resolve `#welcome:zoon.local` → `!welcome:zoon.local`
      if (url.includes('directory/room/%23welcome')) {
        return new Response(JSON.stringify({ room_id: '!welcome:zoon.local' }), { status: 200 })
      }
      // Resolve `#dev:zoon.local` → `!space:zoon.local`
      if (url.includes('/_matrix/client/v3/directory/room/')) {
        return new Response(JSON.stringify({ room_id: '!space:zoon.local' }), { status: 200 })
      }
      // registerBot, joinRoom, sendStateEvent → 200
      return new Response('{}', { status: 200 })
    })
    const client = new MatrixClient({
      homeserver: 'https://hs.zoon.local',
      asToken: 't',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    const spaceId = await ensureWorkforceSpace({
      client,
      asUserId: '@zooid:zoon.local',
      serverName: 'zoon.local',
      spaceLocalpart: 'dev',
      preset: 'public_chat',
    })
    const pool = new BotPool(client, [
      {
        name: 'planner',
        userId: '@planner:zoon.local',
        rooms: [{ alias: '#welcome:zoon.local' }],
        trigger: 'mention',
      },
    ])
    await pool.bootstrap({ spaceRoomId: spaceId, asUserId: '@zooid:zoon.local' })

    const childWrites = calls.filter(
      (c) =>
        c.url.includes('/state/m.space.child/') && c.init?.method === 'PUT',
    )
    expect(childWrites).toHaveLength(1)
    const stateKey = decodeURIComponent(
      childWrites[0]!.url.split('/state/m.space.child/')[1]!.split('?')[0]!,
    )
    expect(stateKey).toBe('!welcome:zoon.local')
  })
})
