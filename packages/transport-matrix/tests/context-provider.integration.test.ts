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

    // 4. getRoomInfo + getChannelMembers
    const info = await provider.getRoomInfo(roomId)
    expect(info).toEqual({ id: roomId, name: 'context test room', transport: 'matrix' })

    const members = await provider.getChannelMembers(roomId)
    const byId = new Map(members.map((m) => [m.id, m]))
    expect(byId.get(BOT_USER)).toMatchObject({ is_agent: true, agent_name: 'devctx' })
    expect([...byId.keys()]).toContain(alice.user_id)
  }, 120_000)

  // --- has_more peeks (zooid-ai/zooid#110, #122), checked live in #123 ---

  it('room /messages at the start of history: records whether Tuwunel still returns `end`', async () => {
    const { roomId } = await setupRoom('start-of-history')
    await asSend(roomId, 'm.room.message', { msgtype: 'm.text', body: 'only message' })

    // Walk the unfiltered timeline back to m.room.create, then one step past.
    let from: string | undefined
    const pages: Array<{ n: number; end: boolean; create: boolean }> = []
    for (let i = 0; i < 20; i++) {
      const page = await rawMessages(roomId, { limit: 5, from })
      const create = page.chunk.some((e) => e.type === 'm.room.create')
      pages.push({ n: page.chunk.length, end: page.end !== undefined, create })
      if (page.end === undefined || page.chunk.length === 0) break
      from = page.end
    }
    console.log('[#123] start-of-history /messages pages:', JSON.stringify(pages))
    expect(pages.some((p) => p.create)).toBe(true)

    // Whatever Tuwunel does with `end`, the provider must report exhaustion.
    const client = new MatrixClient({ homeserver: HS, asToken: AS_TOKEN })
    const provider = newProvider(client)
    const history = await provider.getRoomHistory(roomId, { limit: 50 })
    expect(history.messages.map((m) => m.text)).toEqual(['only message'])
    expect(history.has_more).toBe(false)
    expect(history.next_before).toBeUndefined()
    const threads = await provider.getRecentThreads(roomId, { limit: 50 })
    expect(threads.threads.map((t) => t.text)).toEqual(['only message'])
    expect(threads.has_more).toBe(false)
  }, 120_000)

  it('thread history: a one-reply thread reports has_more false; a multi-page thread paginates exactly', async () => {
    const { roomId } = await setupRoom('thread-pages')
    const provider = newProvider(new MatrixClient({ homeserver: HS, asToken: AS_TOKEN }))

    const solo = await asSend(roomId, 'm.room.message', { msgtype: 'm.text', body: 'solo root' })
    await asSend(roomId, 'm.room.message', threadReply(solo, 'solo reply'))
    for (const limit of [50, 1]) {
      const page = await provider.getThreadHistory(roomId, solo, { limit })
      expect(page.messages.map((m) => m.text)).toEqual(['solo root', 'solo reply'])
      expect(page.has_more).toBe(false)
      expect(page.next_before).toBeUndefined()
    }

    // Root alone, no replies at all.
    const bare = await asSend(roomId, 'm.room.message', { msgtype: 'm.text', body: 'bare root' })
    const barePage = await provider.getThreadHistory(roomId, bare, { limit: 50 })
    expect(barePage.messages.map((m) => m.text)).toEqual(['bare root'])
    expect(barePage.has_more).toBe(false)

    // Seven replies with reactions interleaved, paged three at a time.
    const root = await asSend(roomId, 'm.room.message', { msgtype: 'm.text', body: 'big root' })
    const expected: string[] = []
    for (let i = 0; i < 7; i++) {
      const id = await asSend(roomId, 'm.room.message', threadReply(root, `r${i}`))
      await asSend(roomId, 'm.reaction', {
        'm.relates_to': { rel_type: 'm.annotation', event_id: id, key: '👍' },
      })
      expected.push(`r${i}`)
    }
    const seen: string[] = []
    const flags: boolean[] = []
    let before: string | undefined
    for (let i = 0; i < 10; i++) {
      const page = await provider.getThreadHistory(roomId, root, { limit: 3, before })
      seen.push(...page.messages.map((m) => m.text))
      flags.push(page.has_more)
      if (!page.has_more) break
      before = page.next_before
    }
    expect(seen).toEqual(['big root', ...expected])
    expect(flags).toEqual([true, true, false])
  }, 120_000)

  it('types-filtered peek past a long run of non-message events still finds the older message', async () => {
    const { roomId } = await setupRoom('filtered-peek')
    const client = new MatrixClient({ homeserver: HS, asToken: AS_TOKEN })
    const provider = newProvider(client)

    const old = await asSend(roomId, 'm.room.message', { msgtype: 'm.text', body: 'old' })
    // 150 non-message events: more than any default page size, so a server
    // that applied the filter after the limit would return an empty peek.
    for (let i = 0; i < 75; i++) {
      await asSend(roomId, 'm.reaction', {
        'm.relates_to': { rel_type: 'm.annotation', event_id: old, key: `k${i}` },
      })
      await asSend(roomId, 'dev.zooid.agent_status', { state: 'working', n: i })
    }
    await asSend(roomId, 'm.room.message', { msgtype: 'm.text', body: 'new' })

    // Raw peek, exactly as hasMessagesPast issues it.
    const filter = { types: ['m.room.message'] }
    const first = await client.fetchRoomMessages({ roomId, asUserId: BOT_USER, limit: 1, filter })
    expect(first.chunk.map(bodyOf)).toEqual(['new'])
    const peek = await client.fetchRoomMessages({
      roomId,
      asUserId: BOT_USER,
      limit: 1,
      from: first.end,
      filter,
    })
    expect(peek.chunk.map(bodyOf)).toEqual(['old'])

    const h1 = await provider.getRoomHistory(roomId, { limit: 1 })
    expect(h1.messages.map((m) => m.text)).toEqual(['new'])
    expect(h1.has_more).toBe(true)
    const h2 = await provider.getRoomHistory(roomId, { limit: 1, before: h1.next_before })
    expect(h2.messages.map((m) => m.text)).toEqual(['old'])
    expect(h2.has_more).toBe(false)

    const t1 = await provider.getRecentThreads(roomId, { limit: 1 })
    expect(t1.threads.map((t) => t.text)).toEqual(['new'])
    expect(t1.has_more).toBe(true)
    const t2 = await provider.getRecentThreads(roomId, { limit: 1, before: t1.next_before })
    expect(t2.threads.map((t) => t.text)).toEqual(['old'])
    expect(t2.has_more).toBe(false)
  }, 300_000)

  // Tuwunel ignores `not_rel_types` on /messages, so thread replies arrive
  // with the top-level entries and are dropped client-side. getRecentThreads
  // must keep fetching past them rather than returning thin or empty pages.
  it('recent threads past a long run of thread replies fills the page in one call', async () => {
    const { roomId } = await setupRoom('reply-run')
    const provider = newProvider(new MatrixClient({ homeserver: HS, asToken: AS_TOKEN }))

    const old = await asSend(roomId, 'm.room.message', { msgtype: 'm.text', body: 'old' })
    for (let i = 0; i < 60; i++) {
      await asSend(roomId, 'm.room.message', threadReply(old, `t${i}`))
    }
    await asSend(roomId, 'm.room.message', { msgtype: 'm.text', body: 'new' })

    const page = await provider.getRecentThreads(roomId, { limit: 5 })
    expect(page.threads.map((t) => t.text)).toEqual(['new', 'old'])
    expect(page.has_more).toBe(false)

    // Paging one entry at a time crosses the reply run without an empty page.
    const p1 = await provider.getRecentThreads(roomId, { limit: 1 })
    expect(p1.threads.map((t) => t.text)).toEqual(['new'])
    expect(p1.has_more).toBe(true)
    const p2 = await provider.getRecentThreads(roomId, { limit: 1, before: p1.next_before })
    expect(p2.threads.map((t) => t.text)).toEqual(['old'])
    expect(p2.has_more).toBe(false)
  }, 300_000)

  it('paginates multi-page room history and recent threads to exhaustion with no skipped page', async () => {
    const { roomId } = await setupRoom('exhaust')
    const provider = newProvider(new MatrixClient({ homeserver: HS, asToken: AS_TOKEN }))

    const allMessages: string[] = []
    const topLevel: string[] = []
    for (let i = 0; i < 23; i++) {
      const id = await asSend(roomId, 'm.room.message', { msgtype: 'm.text', body: `m${i}` })
      allMessages.push(`m${i}`)
      topLevel.push(`m${i}`)
      await asSend(roomId, 'dev.zooid.agent_status', { state: 'idle', n: i })
      if (i % 3 === 0) {
        await asSend(roomId, 'm.room.message', threadReply(id, `m${i}.reply`))
        allMessages.push(`m${i}.reply`)
      }
    }

    for (const limit of [7, 10, allMessages.length]) {
      const pages: string[][] = []
      const flags: boolean[] = []
      let before: string | undefined
      for (let i = 0; i < 50; i++) {
        const page = await provider.getRoomHistory(roomId, { limit, before })
        pages.push(page.messages.map((m) => m.text))
        flags.push(page.has_more)
        if (!page.has_more) break
        expect(page.next_before).toBeDefined()
        before = page.next_before
      }
      // Pages come newest-first; each page is oldest-first internally.
      expect(pages.reverse().flat()).toEqual(allMessages)
      expect(flags.at(-1)).toBe(false)
      expect(flags.slice(0, -1).every(Boolean)).toBe(true)
      expect(pages.every((p) => p.length > 0)).toBe(true)
    }

    for (const limit of [4, 9, topLevel.length]) {
      const seen: string[] = []
      const flags: boolean[] = []
      let before: string | undefined
      for (let i = 0; i < 50; i++) {
        const page = await provider.getRecentThreads(roomId, { limit, before })
        seen.push(...page.threads.map((t) => t.text))
        flags.push(page.has_more)
        if (!page.has_more) break
        before = page.next_before
      }
      expect(seen).toEqual([...topLevel].reverse())
      expect(flags.at(-1)).toBe(false)
      expect(flags.slice(0, -1).every(Boolean)).toBe(true)
    }
  }, 300_000)
})

function newProvider(client: MatrixClient) {
  return new MatrixContextProvider({
    client,
    asUserId: BOT_USER,
    agentBots: new Map([[BOT_USER, 'devctx']]),
  })
}

/** Fresh room: alice creates it, the AS bot joins. Messages are sent as the bot. */
async function setupRoom(label: string) {
  const alice = await registerUser(`alice-${label}-` + randomUUID().slice(0, 8), 'pw')
  await asRegister(BOT_LOCALPART)
  const { room_id: roomId } = await createRoom(alice.access_token, label)
  await invite(alice.access_token, roomId, BOT_USER)
  await asJoin(roomId, BOT_USER)
  return { roomId, alice }
}

function bodyOf(e: Record<string, unknown>) {
  return (e.content as { body?: string } | undefined)?.body
}

function threadReply(rootEventId: string, body: string) {
  return {
    msgtype: 'm.text',
    body,
    'm.relates_to': { rel_type: 'm.thread', event_id: rootEventId },
  }
}

/** Send any event as the AS bot (rate_limited: false keeps bulk sends fast). */
async function asSend(roomId: string, type: string, content: unknown): Promise<string> {
  const r = await fetch(
    `${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/${randomUUID()}?user_id=${encodeURIComponent(BOT_USER)}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${AS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(content),
    },
  )
  if (!r.ok) throw new Error(`asSend(${type}) failed: ${r.status} ${await r.text()}`)
  return ((await r.json()) as { event_id: string }).event_id
}

/** Unfiltered /messages, dir=b, as the AS bot. */
async function rawMessages(roomId: string, opts: { limit: number; from?: string }) {
  const params = new URLSearchParams({
    dir: 'b',
    limit: String(opts.limit),
    user_id: BOT_USER,
  })
  if (opts.from) params.set('from', opts.from)
  const r = await fetch(
    `${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${params}`,
    { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
  )
  if (!r.ok) throw new Error(`rawMessages failed: ${r.status} ${await r.text()}`)
  return (await r.json()) as { chunk: Array<{ type: string }>; end?: string }
}

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
