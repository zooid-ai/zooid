import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

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

const HS = 'http://localhost:8448'
const AS_PORT = 9099
const AS_TOKEN = 'as-' + randomUUID()
const HS_TOKEN = 'hs-' + randomUUID()

let daemon: ChildProcess | undefined

describe.skipIf(!dockerAvailable())('matrix transport against tuwunel', () => {
  beforeAll(async () => {
    rmSync(regDir, { recursive: true, force: true })
    mkdirSync(regDir, { recursive: true })
    writeFileSync(
      resolve(regDir, 'zooid.yaml'),
      [
        'id: zooid',
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
    execSync(`docker compose -f ${fixtureDir}/docker-compose.yml up -d`, { stdio: 'inherit' })
    await waitFor(`${HS}/_matrix/client/versions`, 60_000)
  }, 90_000)

  afterAll(() => {
    daemon?.kill('SIGTERM')
    execSync(`docker compose -f ${fixtureDir}/docker-compose.yml down -v`, { stdio: 'inherit' })
  })

  it('smoke: single agent, single room, trigger=any — message produces a reply', async () => {
    const alice = await registerUser('alice', 'alicepw')
    const room = await createRoom(alice.access_token, 'test-room')
    await invite(alice.access_token, room.room_id, '@dev:localhost')

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

async function invite(token: string, roomId: string, userId: string) {
  await fetch(
    `${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ user_id: userId }),
    },
  )
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
  rootEventId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await fetch(
      `${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=20`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const j = (await r.json()) as {
      chunk: Array<{ sender: string; content: { body?: string; 'm.relates_to'?: { event_id?: string } }; event_id: string }>
    }
    const reply = j.chunk.find(
      (e) => e.sender === '@dev:localhost' && e.content?.['m.relates_to']?.event_id === rootEventId,
    )
    if (reply) return reply
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('no reply within timeout')
}
