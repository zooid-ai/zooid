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
