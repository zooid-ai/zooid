// End-to-end test for MatrixContextProvider against a real Tuwunel.
// Validates the three context surfaces the way an agent actually exercises
// them via MCP-over-ACP, without mocks.
//
//   1. getRoomHistory       — server-side filter to m.room.message
//   2. getRecentThreads     — adds not_rel_types=[m.thread]; bundled
//                             unsigned[m.relations][m.thread] for reply_count
//   3. getThreadHistory     — /event/{root} + /relations/{root}/m.thread
//
// Boots its own Tuwunel via the shared docker-compose fixture. Independent
// of the smoke-daemon test in integration.test.ts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { MatrixClient } from '../src/matrix-client.js'
import { MatrixContextProvider } from '../src/context-provider.js'
import { startTuwunel, type TuwunelHandle } from './fixtures/tuwunel-fixture.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(here, 'fixtures')
const regDir = resolve(fixtureDir, 'registrations')

function dockerAvailable() {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let HS = ''
const AS_TOKEN = 'as-ctx-' + randomUUID()
const HS_TOKEN = 'hs-ctx-' + randomUUID()
const BOT_LOCALPART = 'devctx'
const BOT_USER = `@${BOT_LOCALPART}:localhost`
let tuwunel: TuwunelHandle | undefined

describe.skipIf(!dockerAvailable())('MatrixContextProvider against tuwunel', () => {
  beforeAll(async () => {
    mkdirSync(regDir, { recursive: true })
    writeFileSync(
      resolve(regDir, 'zooid-ctx.yaml'),
      [
        'id: zooid-ctx',
        // No AS HTTP listener required for these tests — set a port that
        // won't conflict if other AS daemons happen to be alive too.
        `url: http://host.docker.internal:9999`,
        `as_token: ${AS_TOKEN}`,
        `hs_token: ${HS_TOKEN}`,
        'sender_localpart: zooidctx',
        'rate_limited: false',
        'namespaces:',
        '  users:',
        '    - exclusive: true',
        `      regex: '@${BOT_LOCALPART}.*:localhost'`,
        '  aliases: []',
        '  rooms: []',
      ].join('\n'),
    )
    tuwunel = await startTuwunel()
    HS = tuwunel.homeserver
  }, 120_000)

  afterAll(async () => {
    await tuwunel?.down()
  }, 120_000)

  it('reads room timeline + thread overview + thread drilldown for a bot impersonated by the AS', async () => {
    // Set up: Alice (human) creates room, bot user (AS-owned) joins.
    const alice = await registerUser('alice-ctx-' + randomUUID().slice(0, 8), 'pw')
    await asRegister(BOT_LOCALPART)
    const { room_id: roomId } = await createRoom(alice.access_token, 'ctx-test')
    await invite(alice.access_token, roomId, BOT_USER)
    await asJoin(roomId, BOT_USER)
    await setRoomName(alice.access_token, roomId, 'context test room')

    // Conversation:
    //   alice: hello world         <- top-level
    //   alice: kickoff topic       <- becomes a thread root
    //   alice: standalone          <- top-level, no replies
    //   alice: reply A             <- thread reply under 'kickoff topic'
    //   alice: reply B             <- thread reply under 'kickoff topic'
    const m1 = await sendText(alice.access_token, roomId, 'hello world')
    const root = await sendText(alice.access_token, roomId, 'kickoff topic')
    const m3 = await sendText(alice.access_token, roomId, 'standalone')
    const r1 = await sendThreadReply(alice.access_token, roomId, root, 'reply A')
    const r2 = await sendThreadReply(alice.access_token, roomId, root, 'reply B')
    void m1
    void m3
    void r1
    void r2

    const client = new MatrixClient({ homeserver: HS, asToken: AS_TOKEN })
    const provider = new MatrixContextProvider({
      client,
      asUserId: BOT_USER,
      agentBots: new Map([[BOT_USER, 'devctx']]),
    })

    // 1. getRoomHistory: every m.room.message, oldest-first.
    const history = await provider.getRoomHistory(roomId, { limit: 50 })
    const texts = history.messages.map((m) => m.text)
    expect(texts).toContain('hello world')
    expect(texts).toContain('kickoff topic')
    expect(texts).toContain('standalone')
    expect(texts).toContain('reply A')
    expect(texts).toContain('reply B')
    // Thread replies expose thread_id pointing at the root.
    const replyA = history.messages.find((m) => m.text === 'reply A')
    expect(replyA?.thread_id).toBe(root)
    const standalone = history.messages.find((m) => m.text === 'standalone')
    expect(standalone?.thread_id).toBeUndefined()

    // 2. getRecentThreads: top-level only (replies excluded), with reply_count.
    // Bundled relations may take a beat to land on the root event — retry
    // briefly until the homeserver populates m.relations.m.thread.
    let overview = await provider.getRecentThreads(roomId, { limit: 50 })
    for (let i = 0; i < 10; i++) {
      const rootEntry = overview.threads.find((t) => t.id === root)
      if (rootEntry?.reply_count && rootEntry.reply_count >= 2) break
      await new Promise((r) => setTimeout(r, 250))
      overview = await provider.getRecentThreads(roomId, { limit: 50 })
    }
    const overviewTexts = overview.threads.map((t) => t.text)
    expect(overviewTexts).toContain('hello world')
    expect(overviewTexts).toContain('kickoff topic')
    expect(overviewTexts).toContain('standalone')
    expect(overviewTexts).not.toContain('reply A')
    expect(overviewTexts).not.toContain('reply B')
    const rootOverview = overview.threads.find((t) => t.id === root)
    expect(rootOverview?.reply_count).toBeGreaterThanOrEqual(2)
    const standaloneOverview = overview.threads.find((t) => t.text === 'standalone')
    expect(standaloneOverview?.reply_count).toBe(0)

    // 3. getThreadHistory: root first, then replies oldest-first.
    const thread = await provider.getThreadHistory(roomId, root, { limit: 50 })
    const threadTexts = thread.messages.map((m) => m.text)
    expect(threadTexts).toEqual(['kickoff topic', 'reply A', 'reply B'])
    expect(thread.messages.every((m) => m.thread_id === root)).toBe(true)

    // 4. getChannelInfo + getChannelMembers
    const info = await provider.getChannelInfo(roomId)
    expect(info).toEqual({ id: roomId, name: 'context test room', transport: 'matrix' })

    const members = await provider.getChannelMembers(roomId)
    const byId = new Map(members.map((m) => [m.id, m]))
    expect(byId.get(BOT_USER)).toMatchObject({ is_agent: true, agent_name: 'devctx' })
    expect([...byId.keys()]).toContain(alice.user_id)
  }, 120_000)
})

// --- helpers ---

async function registerUser(username: string, password: string) {
  const r = await fetch(`${HS}/_matrix/client/v3/register?kind=user`, {
    method: 'POST',
    body: JSON.stringify({
      auth: { type: 'm.login.dummy' },
      username,
      password,
    }),
  })
  if (!r.ok) throw new Error(`register failed ${r.status} ${await r.text()}`)
  return (await r.json()) as { access_token: string; user_id: string }
}

async function asRegister(localpart: string): Promise<void> {
  const r = await fetch(`${HS}/_matrix/client/v3/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AS_TOKEN}` },
    body: JSON.stringify({ type: 'm.login.application_service', username: localpart }),
  })
  if (r.status === 200) return
  if (r.status === 400) {
    const body = (await r.json().catch(() => ({}))) as { errcode?: string }
    if (body.errcode === 'M_USER_IN_USE') return
  }
  throw new Error(`asRegister(${localpart}) failed: ${r.status} ${await r.text()}`)
}

async function asJoin(roomId: string, userId: string): Promise<void> {
  const r = await fetch(
    `${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join?user_id=${encodeURIComponent(userId)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${AS_TOKEN}`, 'content-type': 'application/json' },
      body: '{}',
    },
  )
  if (!r.ok) throw new Error(`asJoin(${roomId}, ${userId}) failed: ${r.status} ${await r.text()}`)
}

async function createRoom(token: string, name: string) {
  const r = await fetch(`${HS}/_matrix/client/v3/createRoom`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, preset: 'public_chat' }),
  })
  return (await r.json()) as { room_id: string }
}

async function invite(token: string, roomId: string, userId: string) {
  const r = await fetch(
    `${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
    },
  )
  if (!r.ok) throw new Error(`invite(${userId}) failed: ${r.status} ${await r.text()}`)
}

async function setRoomName(token: string, roomId: string, name: string) {
  const r = await fetch(
    `${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    },
  )
  if (!r.ok) throw new Error(`setRoomName failed: ${r.status} ${await r.text()}`)
}

async function sendText(token: string, roomId: string, body: string): Promise<string> {
  const txn = randomUUID()
  const r = await fetch(
    `${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'm.text', body }),
    },
  )
  if (!r.ok) throw new Error(`sendText failed: ${r.status} ${await r.text()}`)
  return ((await r.json()) as { event_id: string }).event_id
}

async function sendThreadReply(
  token: string,
  roomId: string,
  rootEventId: string,
  body: string,
): Promise<string> {
  const txn = randomUUID()
  const r = await fetch(
    `${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'm.text',
        body,
        'm.relates_to': { rel_type: 'm.thread', event_id: rootEventId },
      }),
    },
  )
  if (!r.ok) throw new Error(`sendThreadReply failed: ${r.status} ${await r.text()}`)
  return ((await r.json()) as { event_id: string }).event_id
}
