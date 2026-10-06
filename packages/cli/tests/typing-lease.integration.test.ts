import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MatrixClient } from '@zooid/transport-matrix'
import { writeBootstrapConfigs } from '../src/bootstrap/configs.js'
import { resolvePaths } from '../src/bootstrap/paths.js'
import { ensureTokens } from '../src/bootstrap/tokens.js'
import { TuwunelService } from '../src/services/tuwunel.js'

function dockerAvailable(): boolean {
  try { execSync('docker info', { stdio: 'ignore' }); return true } catch { return false }
}

// 18448 is zooid-dev.integration, 18449 is zooid-dev-cycle2.integration.
const HOST_PORT = 18450
const HS = `http://localhost:${HOST_PORT}`
const AGENT = '@lease-agent:localhost'
const WATCHER = '@lease-watcher:localhost'

let workDir: string
let svc: TuwunelService
let asToken: string

/** Latest m.typing user_ids for roomId seen by WATCHER, or undefined if none this batch. */
async function syncTyping(roomId: string, since?: string) {
  const p = new URLSearchParams({ user_id: WATCHER, timeout: '1000' })
  if (since) p.set('since', since)
  const r = await fetch(`${HS}/_matrix/client/v3/sync?${p}`, { headers: { Authorization: `Bearer ${asToken}` } })
  if (!r.ok) throw new Error(`sync ${r.status}`)
  const j = (await r.json()) as {
    next_batch: string
    rooms?: { join?: Record<string, { ephemeral?: { events?: { type: string; content: { user_ids?: string[] } }[] } }> }
  }
  const ev = j.rooms?.join?.[roomId]?.ephemeral?.events?.filter((e) => e.type === 'm.typing').at(-1)
  return { next: j.next_batch, userIds: ev?.content.user_ids }
}

// With CI set a missing Docker fails the suite (beforeAll) instead of skipping it:
// this file must never pass by skipping on the typing-lease job.
describe.skipIf(!dockerAvailable() && !process.env.CI)('typing lease backstop (ZOD091 property 1)', () => {
  beforeAll(async () => {
    if (!dockerAvailable()) throw new Error('Docker is required when CI is set; this suite must not pass by skipping')
    workDir = mkdtempSync(join(tmpdir(), 'zooid-lease-'))
    const paths = resolvePaths(join(workDir, 'data', 'matrix'))
    const tokens = ensureTokens(paths.envPath)
    asToken = tokens.asToken
    writeBootstrapConfigs({
      paths, serverName: 'localhost', asToken: tokens.asToken, hsToken: tokens.hsToken,
      senderLocalpart: 'zooid', userNamespace: '@.*:localhost',
    })
    svc = new TuwunelService({ name: `zooid-tuwunel-lease-${Date.now()}`, hostPort: HOST_PORT, paths, engine: 'docker' })
    await svc.start()
    await svc.waitHealthy({ url: HS, timeoutMs: 60_000 })
  }, 90_000)

  afterAll(async () => {
    await svc?.stop().catch(() => {})
    rmSync(workDir, { recursive: true, force: true })
  })

  let registered = false

  /** Raise AGENT's typing with a 30s lease, then send nothing more (the daemon "dies"). */
  async function raiseAndAbandon() {
    const client = new MatrixClient({ homeserver: HS, asToken })
    if (!registered) {
      await client.registerBot('lease-agent')
      await client.registerBot('lease-watcher')
      registered = true
    }
    const roomId = await client.createRoom({ roomAliasName: `lease-${Date.now()}`, invite: [AGENT], senderUserId: WATCHER })
    await client.joinRoom(roomId, AGENT)
    let { next } = await syncTyping(roomId)
    await client.setTyping({ roomId, asUserId: AGENT, typing: true, timeoutMs: 30_000 })
    const raisedAt = Date.now()
    const seen = await syncTyping(roomId, next)
    expect(seen.userIds).toContain(AGENT)
    return { roomId, next: seen.next, raisedAt }
  }

  it('Tuwunel expires the lease: a fresh sync after it no longer lists the agent', async () => {
    const { roomId, raisedAt } = await raiseAndAbandon()
    await new Promise((r) => setTimeout(r, 35_000 - (Date.now() - raisedAt)))
    const fresh = await syncTyping(roomId)
    expect(fresh.userIds ?? []).not.toContain(AGENT)
  }, 120_000)

  // Pins an upstream Tuwunel bug: the expiry is never pushed to an incremental
  // /sync. An already-open client keeps the stale indicator until something
  // else changes typing in that room, so the lease is no backstop for a
  // crashed daemon; the daemon lowering typing itself (ZOD091) is the fix for
  // #36. If this test starts failing, Tuwunel fixed it: invert the assertion
  // to `toBeDefined()` with a <=45s bound.
  it('known Tuwunel bug: an already-syncing client is never told the lease expired', async () => {
    const { roomId, raisedAt } = await raiseAndAbandon()
    let since = (await syncTyping(roomId)).next
    let clearedAt: number | undefined
    while (Date.now() - raisedAt < 50_000) {
      const r = await syncTyping(roomId, since)
      since = r.next
      if (r.userIds && !r.userIds.includes(AGENT)) { clearedAt = Date.now(); break }
    }
    expect(clearedAt).toBeUndefined()
  }, 120_000)
})
