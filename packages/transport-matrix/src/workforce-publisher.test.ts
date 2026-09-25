import { describe, expect, it, vi } from 'vitest'
import { MatrixClient } from './matrix-client.js'
import { buildWorkforceRoster, publishWorkforce, WorkforceDirectory } from './workforce-publisher.js'
import type { AgentBinding } from './router.js'

const agents: AgentBinding[] = [
  {
    name: 'planner',
    userId: '@planner:zoon.local',
    rooms: [{ alias: '!eng:zoon.local' }],
    trigger: 'mention',
  },
  {
    name: 'reviewer',
    userId: '@reviewer:zoon.local',
    rooms: [{ alias: '!eng:zoon.local' }, { alias: '!review:zoon.local' }],
    trigger: 'any',
  },
]

describe('buildWorkforceRoster', () => {
  it('emits version, agents list with user_id/name/rooms', () => {
    const roster = buildWorkforceRoster(agents)
    expect(roster).toEqual({
      version: 1,
      agents: [
        { user_id: '@planner:zoon.local', name: 'planner', rooms: ['!eng:zoon.local'] },
        { user_id: '@reviewer:zoon.local', name: 'reviewer', rooms: ['!eng:zoon.local', '!review:zoon.local'] },
      ],
    })
  })

  it('handles empty workforce', () => {
    expect(buildWorkforceRoster([])).toEqual({ version: 1, agents: [] })
  })
})

describe('publishWorkforce', () => {
  it('PUTs dev.zooid.workforce state event on the configured space', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
    const client = new MatrixClient({
      homeserver: 'https://hs.zoon.local',
      asToken: 'as-tok',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })

    await publishWorkforce({
      client,
      spaceRoomId: '!space:zoon.local',
      asUserId: '@zooid:zoon.local',
      agents,
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(
      'https://hs.zoon.local/_matrix/client/v3/rooms/!space%3Azoon.local/state/dev.zooid.workforce/?user_id=%40zooid%3Azoon.local',
    )
    expect(init?.method).toBe('PUT')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer as-tok' })
    expect(JSON.parse(init?.body as string)).toEqual({
      version: 1,
      agents: [
        { user_id: '@planner:zoon.local', name: 'planner', rooms: ['!eng:zoon.local'] },
        { user_id: '@reviewer:zoon.local', name: 'reviewer', rooms: ['!eng:zoon.local', '!review:zoon.local'] },
      ],
    })
  })

  it('keys the roster by workstation so daemons sharing a space never overwrite each other', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
    const client = new MatrixClient({
      homeserver: 'https://hs.zoon.local',
      asToken: 'as-tok',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await publishWorkforce({
      client,
      spaceRoomId: '!space:zoon.local',
      asUserId: '@laptop:zoon.local',
      agents,
      stateKey: 'laptop',
    })
    expect(fetch.mock.calls[0]![0]).toContain('/state/dev.zooid.workforce/laptop?')
  })

  it('throws on non-2xx', async () => {
    const fetch = vi.fn(async () => new Response('forbidden', { status: 403 }))
    const client = new MatrixClient({
      homeserver: 'https://hs.zoon.local',
      asToken: 'as-tok',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await expect(
      publishWorkforce({
        client,
        spaceRoomId: '!space:zoon.local',
        asUserId: '@zooid:zoon.local',
        agents,
      }),
    ).rejects.toThrow(/403/)
  })
})

describe('WorkforceDirectory', () => {
  const roster = (...ids: string[]) => ({
    version: 1,
    agents: ids.map((user_id) => ({ user_id, name: user_id, rooms: [] })),
  })

  it('merges every workstation roster in the space', () => {
    const dir = new WorkforceDirectory()
    dir.load([
      { type: 'dev.zooid.workforce', state_key: 'cloud', content: roster('@cloud.product:hs') },
      { type: 'dev.zooid.workforce', state_key: 'laptop', content: roster('@laptop.coding:hs') },
      { type: 'm.room.name', state_key: '', content: { name: 'hq' } },
    ])
    expect([...dir.agentIds].sort()).toEqual(['@cloud.product:hs', '@laptop.coding:hs'])
  })

  it('replaces only the updated workstation, and an emptied roster drops out', () => {
    const dir = new WorkforceDirectory()
    dir.apply('cloud', roster('@cloud.product:hs'))
    dir.apply('laptop', roster('@laptop.coding:hs'))
    dir.apply('cloud', roster('@cloud.scout:hs'))
    expect([...dir.agentIds].sort()).toEqual(['@cloud.scout:hs', '@laptop.coding:hs'])
    dir.apply('laptop', {})
    expect([...dir.agentIds]).toEqual(['@cloud.scout:hs'])
  })
})
