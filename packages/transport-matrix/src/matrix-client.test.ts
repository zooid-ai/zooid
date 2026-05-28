import { describe, it, expect, vi } from 'vitest'
import { MatrixClient } from './matrix-client.js'

function fakeFetch(handler: (req: { url: string; init: RequestInit }) => Promise<Response>) {
  return vi.fn(async (input: RequestInfo, init: RequestInit = {}) => {
    return handler({ url: typeof input === 'string' ? input : input.toString(), init })
  })
}

describe('MatrixClient', () => {
  it('registers a bot using m.login.application_service and the AS token', async () => {
    const fetch = fakeFetch(async ({ url, init }) => {
      expect(url).toBe('https://hs.example.com/_matrix/client/v3/register')
      expect(init.method).toBe('POST')
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer as-secret')
      expect(JSON.parse(init.body as string)).toEqual({
        type: 'm.login.application_service',
        username: 'architect',
      })
      return new Response(
        JSON.stringify({ user_id: '@architect:example.com', device_id: 'D1' }),
        { status: 200 },
      )
    })
    const client = new MatrixClient({
      homeserver: 'https://hs.example.com',
      asToken: 'as-secret',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    const user = await client.registerBot('architect')
    expect(user).toEqual({ user_id: '@architect:example.com', device_id: 'D1' })
  })

  it('treats M_USER_IN_USE as a no-op (idempotent registration)', async () => {
    const fetch = fakeFetch(async () =>
      new Response(JSON.stringify({ errcode: 'M_USER_IN_USE' }), { status: 400 }),
    )
    const client = new MatrixClient({
      homeserver: 'https://hs.example.com',
      asToken: 'as-secret',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await expect(client.registerBot('architect')).resolves.toBeUndefined()
  })

  it('joins a room with user_id query parameter for impersonation', async () => {
    const fetch = fakeFetch(async ({ url, init }) => {
      expect(url).toBe(
        'https://hs.example.com/_matrix/client/v3/join/!r%3Aexample.com?user_id=%40architect%3Aexample.com',
      )
      expect(init.method).toBe('POST')
      return new Response(JSON.stringify({ room_id: '!r:example.com' }), { status: 200 })
    })
    const client = new MatrixClient({
      homeserver: 'https://hs.example.com',
      asToken: 'as-secret',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await client.joinRoom('!r:example.com', '@architect:example.com')
  })

  it('sends m.room.message via PUT with a unique txnId and m.thread relation', async () => {
    const fetch = fakeFetch(async ({ url, init }) => {
      expect(url).toMatch(
        /^https:\/\/hs\.example\.com\/_matrix\/client\/v3\/rooms\/!r%3Aexample\.com\/send\/m\.room\.message\/[0-9a-f-]+\?user_id=%40architect%3Aexample\.com$/,
      )
      expect(init.method).toBe('PUT')
      const body = JSON.parse(init.body as string)
      expect(body.msgtype).toBe('m.text')
      expect(body.body).toBe('reply text')
      expect(body['m.relates_to']).toEqual({
        rel_type: 'm.thread',
        event_id: '$root',
      })
      return new Response(JSON.stringify({ event_id: '$x' }), { status: 200 })
    })
    const client = new MatrixClient({
      homeserver: 'https://hs.example.com',
      asToken: 'as-secret',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await client.sendMessage({
      roomId: '!r:example.com',
      asUserId: '@architect:example.com',
      content: { msgtype: 'm.text', body: 'reply text' },
      threadRoot: '$root',
    })
  })

  it('resolveAlias returns the room id when the homeserver knows the alias', async () => {
    const fetch = fakeFetch(async ({ url }) => {
      expect(url).toBe(
        'https://hs.example.com/_matrix/client/v3/directory/room/%23welcome%3Alocalhost',
      )
      return new Response(JSON.stringify({ room_id: '!abc:localhost' }), { status: 200 })
    })
    const client = new MatrixClient({
      homeserver: 'https://hs.example.com',
      asToken: 'as-secret',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    expect(await client.resolveAlias('#welcome:localhost')).toBe('!abc:localhost')
  })

  it('resolveAlias returns null on M_NOT_FOUND', async () => {
    const fetch = fakeFetch(async () =>
      new Response(JSON.stringify({ errcode: 'M_NOT_FOUND' }), { status: 404 }),
    )
    const client = new MatrixClient({
      homeserver: 'https://hs.example.com',
      asToken: 'as-secret',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    expect(await client.resolveAlias('#nope:localhost')).toBeNull()
  })

  it('createRoom POSTs /createRoom impersonating the sender user', async () => {
    const fetch = fakeFetch(async ({ url, init }) => {
      expect(url).toMatch(
        /\/_matrix\/client\/v3\/createRoom\?user_id=%40admin%3Alocalhost$/,
      )
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body as string)
      expect(body).toMatchObject({
        room_alias_name: 'welcome',
        preset: 'public_chat',
        invite: ['@admin:localhost'],
      })
      return new Response(JSON.stringify({ room_id: '!new:localhost' }), { status: 200 })
    })
    const client = new MatrixClient({
      homeserver: 'https://hs.example.com',
      asToken: 'as-secret',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    const id = await client.createRoom({
      roomAliasName: 'welcome',
      invite: ['@admin:localhost'],
      senderUserId: '@admin:localhost',
    })
    expect(id).toBe('!new:localhost')
  })

  it('createRoom passes optional name as m.room.name when supplied', async () => {
    const fetch = fakeFetch(async ({ init }) => {
      const body = JSON.parse(init.body as string)
      expect(body.name).toBe('Welcome Aboard')
      return new Response(JSON.stringify({ room_id: '!new:localhost' }), { status: 200 })
    })
    const client = new MatrixClient({
      homeserver: 'https://hs.example.com',
      asToken: 'as-secret',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await client.createRoom({
      roomAliasName: 'welcome',
      invite: [],
      senderUserId: '@admin:localhost',
      name: 'Welcome Aboard',
    })
  })

  it('setDisplayName PUTs the displayname endpoint impersonating the user', async () => {
    const fetch = fakeFetch(async ({ url, init }) => {
      expect(url).toBe(
        'https://hs.example.com/_matrix/client/v3/profile/%40docs%3Alocalhost/displayname' +
          '?user_id=%40docs%3Alocalhost',
      )
      expect(init.method).toBe('PUT')
      expect(JSON.parse(init.body as string)).toEqual({ displayname: 'Docs Agent' })
      return new Response('{}', { status: 200 })
    })
    const client = new MatrixClient({
      homeserver: 'https://hs.example.com',
      asToken: 'as-secret',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await client.setDisplayName('@docs:localhost', 'Docs Agent')
  })

  describe('MatrixClient.setTyping', () => {
    it('PUTs typing=true with timeout to the typing endpoint, impersonating the asUserId', async () => {
      const fetch = fakeFetch(async ({ url, init }) => {
        expect(url).toBe(
          'https://hs.example.com/_matrix/client/v3/rooms/!r%3Aexample.com/typing/%40architect%3Aexample.com' +
            '?user_id=%40architect%3Aexample.com',
        )
        expect(init.method).toBe('PUT')
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer as-secret')
        expect(JSON.parse(init.body as string)).toEqual({ typing: true, timeout: 30000 })
        return new Response('{}', { status: 200 })
      })
      const client = new MatrixClient({
        homeserver: 'https://hs.example.com',
        asToken: 'as-secret',
        fetch: fetch as unknown as typeof globalThis.fetch,
      })
      await client.setTyping({
        roomId: '!r:example.com',
        asUserId: '@architect:example.com',
        typing: true,
        timeoutMs: 30_000,
      })
    })

    it('PUTs typing=false without timeout to clear', async () => {
      const fetch = fakeFetch(async ({ init }) => {
        expect(JSON.parse(init.body as string)).toEqual({ typing: false })
        return new Response('{}', { status: 200 })
      })
      const client = new MatrixClient({
        homeserver: 'https://hs.example.com',
        asToken: 'as-secret',
        fetch: fetch as unknown as typeof globalThis.fetch,
      })
      await client.setTyping({
        roomId: '!r:example.com',
        asUserId: '@architect:example.com',
        typing: false,
      })
    })

    it('throws on non-2xx', async () => {
      const fetch = fakeFetch(async () => new Response('boom', { status: 500 }))
      const client = new MatrixClient({
        homeserver: 'https://hs.example.com',
        asToken: 'as-secret',
        fetch: fetch as unknown as typeof globalThis.fetch,
      })
      await expect(
        client.setTyping({ roomId: '!r', asUserId: '@a:x', typing: true }),
      ).rejects.toThrow(/setTyping/)
    })
  })

  describe('MatrixClient.setPresence', () => {
    it('PUTs presence to the presence/status endpoint, impersonating the asUserId', async () => {
      const fetch = fakeFetch(async ({ url, init }) => {
        expect(url).toBe(
          'https://hs.example.com/_matrix/client/v3/presence/%40architect%3Aexample.com/status' +
            '?user_id=%40architect%3Aexample.com',
        )
        expect(init.method).toBe('PUT')
        expect(JSON.parse(init.body as string)).toEqual({ presence: 'online' })
        return new Response('{}', { status: 200 })
      })
      const client = new MatrixClient({
        homeserver: 'https://hs.example.com',
        asToken: 'as-secret',
        fetch: fetch as unknown as typeof globalThis.fetch,
      })
      await client.setPresence({ asUserId: '@architect:example.com', presence: 'online' })
    })

    it('includes status_msg when provided', async () => {
      const fetch = fakeFetch(async ({ init }) => {
        expect(JSON.parse(init.body as string)).toEqual({
          presence: 'unavailable',
          status_msg: 'running prompt',
        })
        return new Response('{}', { status: 200 })
      })
      const client = new MatrixClient({
        homeserver: 'https://hs.example.com',
        asToken: 'as-secret',
        fetch: fetch as unknown as typeof globalThis.fetch,
      })
      await client.setPresence({
        asUserId: '@architect:example.com',
        presence: 'unavailable',
        statusMsg: 'running prompt',
      })
    })

    it('throws on non-2xx', async () => {
      const fetch = fakeFetch(async () => new Response('nope', { status: 403 }))
      const client = new MatrixClient({
        homeserver: 'https://hs.example.com',
        asToken: 'as-secret',
        fetch: fetch as unknown as typeof globalThis.fetch,
      })
      await expect(
        client.setPresence({ asUserId: '@a:x', presence: 'online' }),
      ).rejects.toThrow(/setPresence/)
    })
  })

  it('sends a custom event type when content type is set', async () => {
    const fetch = fakeFetch(async ({ url, init }) => {
      expect(url).toMatch(/\/send\/eco\.zoon\.approval_request\//)
      const body = JSON.parse(init.body as string)
      expect(body.approval_id).toBe('a1')
      return new Response(JSON.stringify({ event_id: '$x' }), { status: 200 })
    })
    const client = new MatrixClient({
      homeserver: 'https://hs.example.com',
      asToken: 'as-secret',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await client.sendCustomEvent({
      roomId: '!r:example.com',
      asUserId: '@architect:example.com',
      eventType: 'eco.zoon.approval_request',
      content: { approval_id: 'a1', description: 'Run: git push' },
    })
  })
})

describe('MatrixClient.invite', () => {
  it('POSTs to /invite with the user_id payload, impersonating the inviter', async () => {
    const fetch = fakeFetch(async ({ url, init }) => {
      expect(url).toBe(
        'https://hs.example.com/_matrix/client/v3/rooms/!space%3Aexample.com/invite' +
          '?user_id=%40zooid%3Aexample.com',
      )
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body as string)).toEqual({ user_id: '@planner:example.com' })
      return new Response('{}', { status: 200 })
    })
    const client = new MatrixClient({
      homeserver: 'https://hs.example.com',
      asToken: 'as',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await client.invite({
      roomId: '!space:example.com',
      asUserId: '@zooid:example.com',
      targetUserId: '@planner:example.com',
    })
  })

  it('silently swallows the idempotent "already in the room" 403', async () => {
    const fetch = fakeFetch(async () =>
      new Response(
        JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'User is already in the room' }),
        { status: 403 },
      ),
    )
    const client = new MatrixClient({
      homeserver: 'https://hs.example.com',
      asToken: 'as',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await expect(
      client.invite({
        roomId: '!r:example.com',
        asUserId: '@zooid:example.com',
        targetUserId: '@planner:example.com',
      }),
    ).resolves.toBeUndefined()
  })

  it('rethrows a real permission 403 (no idempotency phrase in body)', async () => {
    const fetch = fakeFetch(async () =>
      new Response(
        JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'You do not have power to invite' }),
        { status: 403 },
      ),
    )
    const client = new MatrixClient({
      homeserver: 'https://hs.example.com',
      asToken: 'as',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await expect(
      client.invite({
        roomId: '!r:example.com',
        asUserId: '@zooid:example.com',
        targetUserId: '@planner:example.com',
      }),
    ).rejects.toThrow(/invite/)
  })
})

describe('MatrixClient.createRoom userPowerLevels', () => {
  it('forwards userPowerLevels into power_level_content_override.users', async () => {
    const fetch = fakeFetch(async ({ init }) => {
      const body = JSON.parse(init.body as string)
      expect(body.power_level_content_override).toEqual({
        users: {
          '@zooid:example.com': 100,
          '@admin:example.com': 100,
          '@mod:example.com': 50,
        },
      })
      return new Response(JSON.stringify({ room_id: '!r:example.com' }), { status: 200 })
    })
    const client = new MatrixClient({
      homeserver: 'https://hs.example.com',
      asToken: 'as',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await client.createRoom({
      roomAliasName: 'x',
      invite: [],
      senderUserId: '@zooid:example.com',
      userPowerLevels: {
        '@zooid:example.com': 100,
        '@admin:example.com': 100,
        '@mod:example.com': 50,
      },
    })
  })

  it('omits power_level_content_override when userPowerLevels is empty or absent', async () => {
    const fetch = fakeFetch(async ({ init }) => {
      const body = JSON.parse(init.body as string)
      expect(body.power_level_content_override).toBeUndefined()
      return new Response(JSON.stringify({ room_id: '!r:example.com' }), { status: 200 })
    })
    const client = new MatrixClient({
      homeserver: 'https://hs.example.com',
      asToken: 'as',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await client.createRoom({
      roomAliasName: 'x',
      invite: [],
      senderUserId: '@zooid:example.com',
    })
  })
})

describe('MatrixClient.createRoom restricted', () => {
  it('injects a restricted join rule referencing the space when restrictedToSpaceId is set', async () => {
    const fetch = fakeFetch(async ({ url, init }) => {
      expect(url).toContain('/_matrix/client/v3/createRoom')
      const body = JSON.parse(init.body as string)
      expect(body.room_alias_name).toBe('design')
      expect(body.initial_state).toContainEqual({
        type: 'm.room.join_rules',
        state_key: '',
        content: {
          join_rule: 'restricted',
          allow: [{ type: 'm.room_membership', room_id: '!space:example.com' }],
        },
      })
      return new Response(JSON.stringify({ room_id: '!new:example.com' }), { status: 200 })
    })
    const client = new MatrixClient({
      homeserver: 'https://hs.example.com',
      asToken: 'as-secret',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    const id = await client.createRoom({
      roomAliasName: 'design',
      invite: [],
      senderUserId: '@architect:example.com',
      restrictedToSpaceId: '!space:example.com',
    })
    expect(id).toBe('!new:example.com')
  })

  it('omits the restricted join rule when no space is given (public room, unchanged)', async () => {
    const fetch = fakeFetch(async ({ init }) => {
      const body = JSON.parse(init.body as string)
      expect(body.initial_state).toBeUndefined()
      return new Response(JSON.stringify({ room_id: '!r:example.com' }), { status: 200 })
    })
    const client = new MatrixClient({
      homeserver: 'https://hs.example.com',
      asToken: 'as-secret',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await client.createRoom({ roomAliasName: 'x', invite: [], senderUserId: '@a:example.com' })
  })
})
