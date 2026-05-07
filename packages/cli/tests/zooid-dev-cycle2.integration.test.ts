import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runDev } from '../src/commands/dev.js'

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const HOST_PORT = 18449
const HS = `http://localhost:${HOST_PORT}`
const UI_PORT = 15173
const AS_PORT = 19099

let workDir: string
let stopDev: () => Promise<void>

const yaml = [
  'transports:',
  '  m:',
  '    type: matrix',
  `    homeserver: ${HS}`,
  '    as_token: ${MATRIX_AS_TOKEN}',
  '    hs_token: ${MATRIX_HS_TOKEN}',
  '    sender_localpart: zooid',
  '    user_namespace: "@.*:localhost"',
  `    port: ${AS_PORT}`,
  'agents:',
  '  assistant:',
  '    transport: m',
  '    matrix_user_id: "@assistant:localhost"',
  '    rooms: ["!placeholder:localhost"]',
  '    trigger: mention',
  '    workdir: .',
  '    acp: { preset: claude }',
].join('\n')

describe.skipIf(!dockerAvailable())(
  'zooid dev cycle 2 — daemon + UI + cascade',
  () => {
    beforeAll(async () => {
      workDir = mkdtempSync(join(tmpdir(), 'zooid-dev2-'))
      writeFileSync(join(workDir, 'workforce.yaml'), yaml)
      const stubDist = join(workDir, 'web-dist')
      execSync(`mkdir -p "${stubDist}"`)
      writeFileSync(join(stubDist, 'index.html'), '<!doctype html><div id=root></div>')
      process.env.ZOOID_DEV_WEB_ROOT_OVERRIDE = stubDist

      const handle = await runDev({
        cwd: workDir,
        dataDir: join(workDir, 'data'),
        hostPort: HOST_PORT,
        uiPort: UI_PORT,
        engine: 'docker',
        adminUser: 'admin',
        adminPassword: 'admin',
        installSignalHandlers: false,
        foreground: false,
      })
      stopDev = handle.stop
    }, 120_000)

    afterAll(async () => {
      await stopDev?.().catch(() => {})
      rmSync(workDir, { recursive: true, force: true })
      delete process.env.ZOOID_DEV_WEB_ROOT_OVERRIDE
    })

    it('daemon AS callback port answers HTTP', async () => {
      const r = await fetch(`http://localhost:${AS_PORT}/`).catch(() => null)
      expect(r).not.toBeNull()
      expect(r!.status).toBeGreaterThan(0)
    })

    it('UI serves index.html and a synthesized /config.json', async () => {
      const index = await fetch(`http://localhost:${UI_PORT}/`)
      expect(index.status).toBe(200)
      expect(await index.text()).toContain('id=root')

      const cfg = await fetch(`http://localhost:${UI_PORT}/config.json`)
      expect(cfg.status).toBe(200)
      expect(await cfg.json()).toEqual({ homeserver_url: HS })
    })

    it('admin user can log in via Tuwunel', async () => {
      const r = await fetch(`${HS}/_matrix/client/v3/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'admin' },
          password: 'admin',
        }),
      })
      expect(r.ok).toBe(true)
    })

    it('cascade stops every layer cleanly and is idempotent', async () => {
      await stopDev()
      await stopDev()
      const r = await fetch(HS).catch(() => null)
      expect(r === null || !r.ok).toBe(true)
    })

    it('a second runDev against the same data dir reuses tokens and the admin', async () => {
      const handle = await runDev({
        cwd: workDir,
        dataDir: join(workDir, 'data'),
        hostPort: HOST_PORT,
        uiPort: UI_PORT + 1,
        engine: 'docker',
        adminUser: 'admin',
        adminPassword: 'admin',
        installSignalHandlers: false,
        foreground: false,
      })
      try {
        const env = readFileSync(
          join(workDir, 'data', 'matrix', 'config', '.env'),
          'utf8',
        )
        expect(env).toMatch(/MATRIX_AS_TOKEN=/)
        const login = await fetch(`${HS}/_matrix/client/v3/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'admin' },
            password: 'admin',
          }),
        })
        expect(login.ok).toBe(true)
      } finally {
        await handle.stop()
      }
      expect(
        existsSync(join(workDir, 'data', 'matrix', 'config', 'tuwunel.toml')),
      ).toBe(true)
    }, 120_000)
  },
  180_000,
)
