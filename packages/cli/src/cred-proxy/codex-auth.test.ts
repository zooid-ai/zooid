import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CredentialExpiredError, createCodexAuth } from './codex-auth.js'

const T = 1_800_000_000_000
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
// Test JWTs only: unsigned, fake account.
const jwt = (tag: string, account = 'acct-1') =>
  `${b64({ alg: 'none' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: account }, tag })}.x`
const A1 = jwt('a1')
const A2 = jwt('a2')
const A3 = jwt('a3')

let dir: string
let authFile: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zod128-auth-'))
  authFile = join(dir, 'auth.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function writeAuth(expires: number, access = A1, extra: Record<string, unknown> = {}) {
  writeFileSync(
    authFile,
    JSON.stringify({
      'openai-codex': { type: 'oauth', access, refresh: 'R1', expires, accountId: 'acct-1' },
      ...extra,
    }),
    { mode: 0o600 },
  )
}

const okRefresh = () =>
  vi.fn(async () =>
    new Response(JSON.stringify({ access_token: A2, refresh_token: 'R2', expires_in: 864000 }), { status: 200 }),
  )

describe('createCodexAuth', () => {
  it('passes a fresh token through without refreshing', async () => {
    writeAuth(T + 3_600_000)
    const fetchImpl = vi.fn()
    const auth = createCodexAuth({ authFile, fetchImpl, now: () => T })
    expect(await auth.current()).toEqual({ access: A1, accountId: 'acct-1' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refreshes near expiry and writes the new token back, keeping other providers', async () => {
    writeAuth(T + 120_000, A1, { anthropic: { type: 'api', key: 'k' } })
    const fetchImpl = okRefresh()
    const auth = createCodexAuth({ authFile, fetchImpl, now: () => T })
    expect((await auth.current()).access).toBe(A2)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://auth.openai.com/oauth/token')
    expect(init.method).toBe('POST')
    expect(String(init.body)).toBe(
      'grant_type=refresh_token&refresh_token=R1&client_id=app_EMoamEEZ73f0CkXaXp7hrann',
    )
    const file = JSON.parse(readFileSync(authFile, 'utf8'))
    expect(file['openai-codex']).toEqual({
      type: 'oauth',
      access: A2,
      refresh: 'R2',
      expires: T + 864_000_000,
      accountId: 'acct-1',
    })
    expect(file.anthropic).toEqual({ type: 'api', key: 'k' })
    expect(statSync(authFile).mode & 0o777).toBe(0o600)
    expect(existsSync(authFile + '.zooid-lock')).toBe(false)
  })

  it('refreshes once for concurrent callers', async () => {
    writeAuth(T + 120_000)
    const fetchImpl = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10))
      return new Response(JSON.stringify({ access_token: A2, refresh_token: 'R2', expires_in: 864000 }))
    })
    const auth = createCodexAuth({ authFile, fetchImpl, now: () => T })
    const got = await Promise.all([auth.current(), auth.current(), auth.current()])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(got.map((g) => g.access)).toEqual([A2, A2, A2])
  })

  it('re-reads under the lock and uses a token another process refreshed', async () => {
    writeAuth(T + 120_000)
    // Another refresher holds the lock, writes a fresh token, then releases.
    writeFileSync(authFile + '.zooid-lock', '')
    const fetchImpl = vi.fn()
    const auth = createCodexAuth({ authFile, fetchImpl, now: () => T })
    const p = auth.current()
    await new Promise((r) => setTimeout(r, 50))
    writeAuth(T + 3_600_000, A3)
    unlinkSync(authFile + '.zooid-lock')
    expect((await p).access).toBe(A3)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('breaks a stale lock', async () => {
    writeAuth(T + 120_000)
    writeFileSync(authFile + '.zooid-lock', '')
    const old = (Date.now() - 60_000) / 1000
    utimesSync(authFile + '.zooid-lock', old, old)
    const auth = createCodexAuth({ authFile, fetchImpl: okRefresh(), now: () => T })
    expect((await auth.current()).access).toBe(A2)
    expect(existsSync(authFile + '.zooid-lock')).toBe(false)
  })

  it('waits for a live lock', async () => {
    writeAuth(T + 120_000)
    writeFileSync(authFile + '.zooid-lock', '')
    const fetchImpl = okRefresh()
    const auth = createCodexAuth({ authFile, fetchImpl, now: () => T })
    let released = false
    setTimeout(() => {
      released = true
      unlinkSync(authFile + '.zooid-lock')
    }, 100)
    expect((await auth.current()).access).toBe(A2)
    expect(released).toBe(true)
  })

  it('a rejected refresh is CredentialExpiredError, with no token or body in the message', async () => {
    writeAuth(T + 120_000)
    const fetchImpl = vi.fn(async () => new Response('{"error":"refresh_token_invalidated"}', { status: 400 }))
    const auth = createCodexAuth({ authFile, fetchImpl, now: () => T })
    const err = await auth.current().catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(CredentialExpiredError)
    expect(err.message).toContain(authFile)
    expect(err.message).toContain('/login → OpenAI Codex → device code')
    expect(err.message).toContain(`PI_CODING_AGENT_DIR=${dir} pi`)
    expect(err.message).not.toContain('R1')
    expect(err.message).not.toContain('refresh_token_invalidated')
  })

  it('a missing file is CredentialExpiredError', async () => {
    const auth = createCodexAuth({ authFile, fetchImpl: vi.fn(), now: () => T })
    await expect(auth.current()).rejects.toBeInstanceOf(CredentialExpiredError)
  })

  it('a file without an openai-codex entry is CredentialExpiredError', async () => {
    writeFileSync(authFile, JSON.stringify({ anthropic: { type: 'api', key: 'k' } }))
    const auth = createCodexAuth({ authFile, fetchImpl: vi.fn(), now: () => T })
    await expect(auth.current()).rejects.toBeInstanceOf(CredentialExpiredError)
  })

  it('a malformed refresh response is CredentialExpiredError and leaves the file alone', async () => {
    writeAuth(T + 120_000)
    const before = readFileSync(authFile, 'utf8')
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: A2 })))
    const auth = createCodexAuth({ authFile, fetchImpl, now: () => T })
    await expect(auth.current()).rejects.toBeInstanceOf(CredentialExpiredError)
    expect(readFileSync(authFile, 'utf8')).toBe(before)
  })
})
