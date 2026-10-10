import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// Read from @earendil-works/pi-ai/dist/auth/oauth/openai-codex.js (pi 0.87.1).
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const ACCOUNT_CLAIM = 'https://api.openai.com/auth'
const PROVIDER = 'openai-codex'

const LOCK_STALE_MS = 30_000
const LOCK_POLL_MS = 25

export class CredentialExpiredError extends Error {
  override name = 'CredentialExpiredError'
}

export interface CodexAuth {
  current(): Promise<{ access: string; accountId: string }>
}

interface CodexEntry {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  accountId?: string
  [k: string]: unknown
}

export interface CreateCodexAuthOptions {
  /** pi's `auth.json` for a login only the proxy uses. */
  authFile: string
  fetchImpl?: typeof fetch
  now?: () => number
  refreshSkewMs?: number
}

function accountIdOf(access: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(access.split('.')[1] ?? '', 'base64url').toString('utf8'))
    const id = payload?.[ACCOUNT_CLAIM]?.chatgpt_account_id
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The proxy's view of a pi `openai-codex` OAuth login. Reads the file on each
 * call and refreshes near expiry. Refresh tokens rotate, so this must be the
 * only refresher of its file: a lock beside it keeps two daemons from racing,
 * and a re-read under the lock picks up the winner's token. No token or
 * response body ever goes into an error. [ZOD128]
 */
export function createCodexAuth(opts: CreateCodexAuthOptions): CodexAuth {
  const { authFile } = opts
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const skew = opts.refreshSkewMs ?? 5 * 60_000
  const lockFile = `${authFile}.zooid-lock`
  let inflight: Promise<{ access: string; accountId: string }> | undefined

  const expired = () =>
    new CredentialExpiredError(
      `openai-codex login for vm agents is missing or expired (${authFile}). ` +
        `Log in again: PI_CODING_AGENT_DIR=${dirname(authFile)} pi, then /login → OpenAI Codex → device code`,
    )

  function read(): { file: Record<string, unknown>; entry: CodexEntry } {
    let file: Record<string, unknown>
    try {
      file = JSON.parse(readFileSync(authFile, 'utf8'))
    } catch {
      throw expired()
    }
    const entry = file?.[PROVIDER] as CodexEntry | undefined
    if (!entry || typeof entry.access !== 'string' || typeof entry.refresh !== 'string') throw expired()
    return { file, entry }
  }

  const fresh = (e: CodexEntry) => typeof e.expires === 'number' && e.expires - now() > skew

  function credential(e: CodexEntry) {
    const accountId = accountIdOf(e.access) ?? e.accountId
    if (!accountId) throw expired()
    return { access: e.access, accountId }
  }

  // Lock age is wall-clock (the file's mtime), not the injected token clock.
  async function lock(): Promise<void> {
    for (;;) {
      try {
        closeSync(openSync(lockFile, 'wx'))
        return
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockFile, { force: true })
          continue
        }
      } catch {
        continue // released between open and stat
      }
      await sleep(LOCK_POLL_MS)
    }
  }

  async function refresh(): Promise<{ access: string; accountId: string }> {
    await lock()
    try {
      const { file, entry } = read()
      if (fresh(entry)) return credential(entry)
      let res: Response
      try {
        res = await fetchImpl(TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: entry.refresh,
            client_id: CLIENT_ID,
          }).toString(),
        })
      } catch {
        throw expired()
      }
      if (!res.ok) throw expired()
      const json = (await res.json().catch(() => undefined)) as
        | { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }
        | undefined
      if (
        typeof json?.access_token !== 'string' ||
        typeof json.refresh_token !== 'string' ||
        typeof json.expires_in !== 'number'
      ) {
        throw expired()
      }
      const next: CodexEntry = {
        ...entry,
        type: 'oauth',
        access: json.access_token,
        refresh: json.refresh_token,
        expires: now() + json.expires_in * 1000,
      }
      const accountId = accountIdOf(next.access)
      if (accountId) next.accountId = accountId
      const tmp = `${authFile}.tmp`
      rmSync(tmp, { force: true })
      writeFileSync(tmp, JSON.stringify({ ...file, [PROVIDER]: next }, null, 2), { mode: 0o600 })
      renameSync(tmp, authFile)
      return credential(next)
    } finally {
      rmSync(lockFile, { force: true })
    }
  }

  return {
    async current() {
      const { entry } = read()
      if (fresh(entry)) return credential(entry)
      inflight ??= refresh().finally(() => {
        inflight = undefined
      })
      return inflight
    },
  }
}
