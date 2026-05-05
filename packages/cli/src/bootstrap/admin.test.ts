import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureAdminUser } from './admin.js'

const HS = 'http://localhost:8448'

afterEach(() => vi.restoreAllMocks())

describe('ensureAdminUser', () => {
  it("registers when the user doesn't exist yet", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${HS}/_matrix/client/v3/register`)
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body as string)
      expect(body).toMatchObject({
        username: 'admin',
        password: 'admin',
        auth: { type: 'm.login.dummy' },
        inhibit_login: true,
      })
      return new Response(JSON.stringify({ user_id: '@admin:localhost' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await ensureAdminUser({
      homeserver: HS,
      username: 'admin',
      password: 'admin',
    })
    expect(r.created).toBe(true)
    expect(r.userId).toBe('@admin:localhost')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats M_USER_IN_USE as a no-op (idempotent on repeat runs)', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ errcode: 'M_USER_IN_USE', error: 'taken' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const r = await ensureAdminUser({
      homeserver: HS,
      username: 'admin',
      password: 'admin',
    })
    expect(r.created).toBe(false)
    expect(r.userId).toBe('@admin:localhost')
  })

  it('throws on any other error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'no' }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )
    await expect(
      ensureAdminUser({ homeserver: HS, username: 'admin', password: 'admin' }),
    ).rejects.toThrow(/M_FORBIDDEN/)
  })
})
