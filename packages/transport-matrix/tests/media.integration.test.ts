import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { startTuwunel, type TuwunelHandle } from './fixtures/tuwunel-fixture.js'
import { MediaClient } from '../src/media-client.js'

const here = dirname(fileURLToPath(import.meta.url))
const regDir = resolve(here, 'fixtures', 'registrations')
const AS_TOKEN = 'as-' + randomUUID()

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function dockerAvailable() {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let tuwunel: TuwunelHandle | undefined
let HS = ''

describe.skipIf(!dockerAvailable())('media repo via AS token + user_id impersonation', () => {
  beforeAll(async () => {
    mkdirSync(regDir, { recursive: true })
    writeFileSync(
      resolve(regDir, 'zooid-media.yaml'),
      [
        'id: zooid-media',
        'url: http://host.docker.internal:9098',
        `as_token: ${AS_TOKEN}`,
        `hs_token: hs-${randomUUID()}`,
        'sender_localpart: zooid-media',
        'rate_limited: false',
        'namespaces:',
        '  users:',
        '    - exclusive: true',
        "      regex: '@media.*:localhost'",
        '  aliases: []',
        '  rooms: []',
      ].join('\n'),
    )
    tuwunel = await startTuwunel()
    HS = tuwunel.homeserver
    // register the impersonated AS user
    const r = await fetch(`${HS}/_matrix/client/v3/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AS_TOKEN}` },
      body: JSON.stringify({ type: 'm.login.application_service', username: 'media-agent' }),
    })
    if (!r.ok) throw new Error(`AS register failed: ${r.status} ${await r.text()}`)
  }, 120_000)

  afterAll(async () => await tuwunel?.down(), 120_000)

  it('uploads as the impersonated agent and downloads via authenticated v1 media', async () => {
    const media = new MediaClient({ homeserver: HS, asToken: AS_TOKEN })
    const up = await media.upload({
      data: TINY_PNG,
      contentType: 'image/png',
      filename: 'tiny.png',
      asUserId: '@media-agent:localhost',
    })
    expect(up.content_uri).toMatch(/^mxc:\/\//)

    const down = await media.download({
      mxcUri: up.content_uri,
      asUserId: '@media-agent:localhost',
    })
    expect(Buffer.from(down.data).equals(TINY_PNG)).toBe(true)
    expect(down.contentType).toBe('image/png')
  }, 60_000)

  it('downloads media uploaded by a regular user (the human → agent path)', async () => {
    const reg = await fetch(`${HS}/_matrix/client/v3/register?kind=user`, {
      method: 'POST',
      body: JSON.stringify({ auth: { type: 'm.login.dummy' }, username: 'alice-m', password: 'pw' }),
    })
    const alice = (await reg.json()) as { access_token: string }
    const up = await fetch(`${HS}/_matrix/media/v3/upload?filename=human.png`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.access_token}`, 'Content-Type': 'image/png' },
      body: TINY_PNG,
    })
    const { content_uri } = (await up.json()) as { content_uri: string }

    const media = new MediaClient({ homeserver: HS, asToken: AS_TOKEN })
    const down = await media.download({ mxcUri: content_uri, asUserId: '@media-agent:localhost' })
    expect(Buffer.from(down.data).equals(TINY_PNG)).toBe(true)
  }, 60_000)
})
