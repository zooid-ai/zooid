import { describe, expect, it, vi } from 'vitest'
import { MatrixClient } from './matrix-client.js'
import { ensureDefaultChannel, ensureWorkforceSpace, serverNameFromMxid } from './space-provisioner.js'

function clientWithFetches(...handlers: Array<(url: string, init?: RequestInit) => Response>) {
  let i = 0
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const h = handlers[i++]
    if (!h) throw new Error(`unexpected fetch #${i}: ${url}`)
    return h(url, init)
  })
  const client = new MatrixClient({
    homeserver: 'https://hs.zoon.local',
    asToken: 'as-tok',
    fetch: fetch as unknown as typeof globalThis.fetch,
  })
  return { client, fetch }
}

describe('ensureWorkforceSpace', () => {
  it('returns the room ID when the alias already resolves', async () => {
    const { client, fetch } = clientWithFetches((url) => {
      expect(url).toContain('/_matrix/client/v3/directory/room/%23dev%3Ahs.zoon.local')
      return new Response(JSON.stringify({ room_id: '!existing:hs.zoon.local' }), { status: 200 })
    })
    const id = await ensureWorkforceSpace({
      client,
      asUserId: '@zooid:hs.zoon.local',
      serverName: 'hs.zoon.local',
      spaceLocalpart: 'dev',
      preset: 'public_chat',
    })
    expect(id).toBe('!existing:hs.zoon.local')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('creates the space when the alias is unknown', async () => {
    const { client, fetch } = clientWithFetches(
      () => new Response(JSON.stringify({ errcode: 'M_NOT_FOUND' }), { status: 404 }),
      (url, init) => {
        expect(url).toContain('/_matrix/client/v3/createRoom')
        const body = JSON.parse(init!.body as string)
        expect(body).toMatchObject({
          room_alias_name: 'dev',
          name: 'Dev',
          preset: 'public_chat',
          creation_content: { type: 'm.space' },
        })
        return new Response(JSON.stringify({ room_id: '!new:hs.zoon.local' }), { status: 200 })
      },
    )
    const id = await ensureWorkforceSpace({
      client,
      asUserId: '@zooid:hs.zoon.local',
      serverName: 'hs.zoon.local',
      spaceLocalpart: 'dev',
      preset: 'public_chat',
    })
    expect(id).toBe('!new:hs.zoon.local')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('throws on resolveAlias errors other than 404', async () => {
    const { client } = clientWithFetches(() => new Response('boom', { status: 500 }))
    await expect(
      ensureWorkforceSpace({
        client,
        asUserId: '@zooid:hs.zoon.local',
        serverName: 'hs.zoon.local',
        spaceLocalpart: 'dev',
        preset: 'public_chat',
      }),
    ).rejects.toThrow(/500/)
  })
})

describe('ensureWorkforceSpace privacy', () => {
  it('creates the space invite-only (overriding any public preset)', async () => {
    const { client } = clientWithFetches(
      () => new Response(JSON.stringify({ errcode: 'M_NOT_FOUND' }), { status: 404 }),
      (url, init) => {
        expect(url).toContain('/_matrix/client/v3/createRoom')
        const body = JSON.parse(init!.body as string)
        expect(body.creation_content).toEqual({ type: 'm.space' })
        expect(body.initial_state).toContainEqual({
          type: 'm.room.join_rules',
          state_key: '',
          content: { join_rule: 'invite' },
        })
        return new Response(JSON.stringify({ room_id: '!space:hs.zoon.local' }), { status: 200 })
      },
    )
    const id = await ensureWorkforceSpace({
      client,
      asUserId: '@zooid:hs.zoon.local',
      serverName: 'hs.zoon.local',
      spaceLocalpart: 'dev',
      preset: 'public_chat',
    })
    expect(id).toBe('!space:hs.zoon.local')
  })
})

describe('ensureWorkforceSpace admins', () => {
  it('emits power_level_content_override with bot + admins at 100 on creation', async () => {
    const { client } = clientWithFetches(
      () => new Response(JSON.stringify({ errcode: 'M_NOT_FOUND' }), { status: 404 }),
      (url, init) => {
        expect(url).toContain('/_matrix/client/v3/createRoom')
        const body = JSON.parse(init!.body as string)
        expect(body.power_level_content_override).toEqual({
          users: {
            '@zooid:hs.zoon.local': 100,
            '@admin:hs.zoon.local': 100,
          },
        })
        return new Response(JSON.stringify({ room_id: '!space:hs.zoon.local' }), { status: 200 })
      },
    )
    await ensureWorkforceSpace({
      client,
      asUserId: '@zooid:hs.zoon.local',
      serverName: 'hs.zoon.local',
      spaceLocalpart: 'dev',
      preset: 'public_chat',
      admins: ['@admin:hs.zoon.local'],
    })
  })

  it('omits the override when admins is empty/absent', async () => {
    const { client } = clientWithFetches(
      () => new Response(JSON.stringify({ errcode: 'M_NOT_FOUND' }), { status: 404 }),
      (_url, init) => {
        const body = JSON.parse(init!.body as string)
        expect(body.power_level_content_override).toBeUndefined()
        return new Response(JSON.stringify({ room_id: '!space:hs.zoon.local' }), { status: 200 })
      },
    )
    await ensureWorkforceSpace({
      client,
      asUserId: '@zooid:hs.zoon.local',
      serverName: 'hs.zoon.local',
      spaceLocalpart: 'dev',
      preset: 'public_chat',
    })
  })
})

describe('ensureDefaultChannel', () => {
  it('returns the existing #general room when its alias resolves', async () => {
    const { client, fetch } = clientWithFetches((url) => {
      expect(url).toContain('/_matrix/client/v3/directory/room/%23general%3Ahs.zoon.local')
      return new Response(JSON.stringify({ room_id: '!gen:hs.zoon.local' }), { status: 200 })
    })
    const id = await ensureDefaultChannel({
      client,
      asUserId: '@zooid:hs.zoon.local',
      serverName: 'hs.zoon.local',
      spaceId: '!space:hs.zoon.local',
      channelLocalpart: 'general',
    })
    expect(id).toBe('!gen:hs.zoon.local')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('creates a restricted #general and attaches it to the space when absent', async () => {
    const { client, fetch } = clientWithFetches(
      () => new Response(JSON.stringify({ errcode: 'M_NOT_FOUND' }), { status: 404 }),
      (url, init) => {
        expect(url).toContain('/_matrix/client/v3/createRoom')
        const body = JSON.parse(init!.body as string)
        expect(body.room_alias_name).toBe('general')
        expect(body.initial_state).toContainEqual({
          type: 'm.room.join_rules',
          state_key: '',
          content: {
            join_rule: 'restricted',
            allow: [{ type: 'm.room_membership', room_id: '!space:hs.zoon.local' }],
          },
        })
        return new Response(JSON.stringify({ room_id: '!gen:hs.zoon.local' }), { status: 200 })
      },
      (url, init) => {
        expect(url).toContain(
          '/_matrix/client/v3/rooms/!space%3Ahs.zoon.local/state/m.space.child/!gen%3Ahs.zoon.local',
        )
        expect(JSON.parse(init!.body as string)).toMatchObject({ via: ['hs.zoon.local'] })
        return new Response(JSON.stringify({ event_id: '$e' }), { status: 200 })
      },
    )
    const id = await ensureDefaultChannel({
      client,
      asUserId: '@zooid:hs.zoon.local',
      serverName: 'hs.zoon.local',
      spaceId: '!space:hs.zoon.local',
      channelLocalpart: 'general',
    })
    expect(id).toBe('!gen:hs.zoon.local')
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})

describe('serverNameFromMxid', () => {
  it('returns the part after the first colon', () => {
    expect(serverNameFromMxid('@zooid:zoon.local')).toBe('zoon.local')
  })

  it('handles federated server names with ports', () => {
    expect(serverNameFromMxid('@zooid:hs.example.com:8448')).toBe('hs.example.com:8448')
  })

  it('throws on an mxid without a server', () => {
    expect(() => serverNameFromMxid('@zooid')).toThrow(/server/)
  })
})
