import { describe, expect, it, vi } from 'vitest'
import { MatrixClient } from './matrix-client.js'
import { buildWorkforceRoster, publishWorkforce } from './workforce-publisher.js'
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
  it('PUTs eco.zoon.workforce state event on the configured space', async () => {
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
      'https://hs.zoon.local/_matrix/client/v3/rooms/!space%3Azoon.local/state/eco.zoon.workforce/?user_id=%40zooid%3Azoon.local',
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
