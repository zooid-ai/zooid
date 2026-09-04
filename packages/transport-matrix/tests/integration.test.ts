import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
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
const AS_PORT = 9099
const AS_TOKEN = 'as-' + randomUUID()
const HS_TOKEN = 'hs-' + randomUUID()

let daemon: ChildProcess | undefined
let tuwunel: TuwunelHandle | undefined

describe.skipIf(!dockerAvailable())('matrix transport against tuwunel', () => {
  beforeAll(async () => {
    mkdirSync(regDir, { recursive: true })
    writeFileSync(
      resolve(regDir, 'zooid-smoke.yaml'),
      [
        'id: zooid-smoke',
        `url: http://host.docker.internal:${AS_PORT}`,
        `as_token: ${AS_TOKEN}`,
        `hs_token: ${HS_TOKEN}`,
        'sender_localpart: zooid',
        'rate_limited: false',
        'namespaces:',
        '  users:',
        '    - exclusive: true',
        "      regex: '@dev.*:localhost'",
        '  aliases: []',
        '  rooms: []',
      ].join('\n'),
    )
    tuwunel = await startTuwunel()
    HS = tuwunel.homeserver
  }, 120_000)

  // Same budget as beforeAll: teardown contends for the same docker daemon
  // that setup does, and three integration files tear their stacks down at
  // once. 30s was arbitrary and lost that race routinely.
  afterAll(async () => {
    if (daemon) {
      const exited = new Promise<void>((r) => daemon!.once('exit', () => r()))
      daemon.kill('SIGTERM')
      // Let the daemon close its /sync long-polls before the homeserver goes
      // away — yanking the container out from under a live client is what
      // makes `compose down` crawl.
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))])
    }
    await tuwunel?.down()
  }, 120_000)

  it('smoke: single agent, single room, trigger=any — message produces a reply', async () => {
    const alice = await registerUser('alice', 'alicepw')
    const room = await createRoom(alice.access_token, 'test-room')
    // The bot is placed in the room by the application service at startup
    // (transport.bootstrap → BotPool joins each binding's room as the agent
    // user), exactly as real `zooid` startup does. Bots are workforce-as-code:
    // they decline ad-hoc human invites by design, so a UI/API invite would be
    // declined and kick the bot back out (→ 403 on send). The binding carries
    // the room id, so bootstrap joins it directly.

    daemon = spawn(
      'pnpm',
      ['-C', resolve(here, '..'), 'exec', 'tsx', 'tests/fixtures/echo-daemon.ts'],
      {
        env: {
          ...process.env,
          MATRIX_HS: HS,
          MATRIX_AS_TOKEN: AS_TOKEN,
          MATRIX_HS_TOKEN: HS_TOKEN,
          MATRIX_AGENT_USER: '@dev:localhost',
          MATRIX_ROOM: room.room_id,
          MATRIX_PORT: String(AS_PORT),
        },
        stdio: 'inherit',
      },
    )
    await waitFor(`http://localhost:${AS_PORT}/healthz`, 30_000)

    const sentEvtId = await sendText(alice.access_token, room.room_id, 'ping from alice')

    const reply = await waitForReply(alice.access_token, room.room_id, sentEvtId, 30_000)
    expect(reply.sender).toBe('@dev:localhost')
    expect(reply.content.body).toContain('ping from alice')
  }, 120_000)
})

// --- helpers ---

async function waitFor(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${url}`)
}

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

async function createRoom(token: string, name: string) {
  const r = await fetch(`${HS}/_matrix/client/v3/createRoom`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, preset: 'public_chat' }),
  })
  return (await r.json()) as { room_id: string }
}

async function sendText(token: string, roomId: string, body: string) {
  const txn = randomUUID()
  const r = await fetch(
    `${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ msgtype: 'm.text', body }),
    },
  )
  return ((await r.json()) as { event_id: string }).event_id
}

async function waitForReply(
  token: string,
  roomId: string,
  _rootEventId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await fetch(
      `${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=20`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const j = (await r.json()) as {
      chunk: Array<{ sender: string; type: string; content: { msgtype?: string; body?: string }; event_id: string }>
    }
    // Non-threaded replies have no m.relates_to; match any room message from the agent.
    const reply = j.chunk.find(
      (e) => e.sender === '@dev:localhost' && e.type === 'm.room.message',
    )
    if (reply) return reply
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('no reply within timeout')
}
