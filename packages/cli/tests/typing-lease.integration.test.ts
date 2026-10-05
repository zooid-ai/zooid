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

const HOST_PORT = 18449
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

  it('a raised indicator clears within the lease with nothing further sent', async () => {
    const client = new MatrixClient({ homeserver: HS, asToken })
    await client.registerBot('lease-agent')
    await client.registerBot('lease-watcher')
    const roomId = await client.createRoom({ roomAliasName: `lease-${Date.now()}`, invite: [AGENT], senderUserId: WATCHER })
    await client.joinRoom(roomId, AGENT)

    let { next } = await syncTyping(roomId)
    await client.setTyping({ roomId, asUserId: AGENT, typing: true, timeoutMs: 30_000 })
    const raisedAt = Date.now()
    // The daemon "dies" here: no refresh, no lower.

    let sawRaised = false
    let clearedAt: number | undefined
    while (Date.now() - raisedAt < 50_000) {
      const r = await syncTyping(roomId, next)
      next = r.next
      if (r.userIds?.includes(AGENT)) sawRaised = true
      if (sawRaised && r.userIds && !r.userIds.includes(AGENT)) { clearedAt = Date.now(); break }
    }
    console.log(`[typing-lease] measured clearedAt - raisedAt = ${clearedAt === undefined ? 'never cleared' : `${clearedAt - raisedAt}ms`}`)
    expect(sawRaised).toBe(true)
    expect(clearedAt, 'Tuwunel never expired the typing lease').toBeDefined()
    expect(clearedAt! - raisedAt).toBeLessThanOrEqual(45_000)
  }, 120_000)
})
