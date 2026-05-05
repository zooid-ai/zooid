import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureAdminUser } from '../src/bootstrap/admin.js'
import { writeBootstrapConfigs } from '../src/bootstrap/configs.js'
import { resolvePaths } from '../src/bootstrap/paths.js'
import { ensureTokens } from '../src/bootstrap/tokens.js'
import { TuwunelService } from '../src/services/tuwunel.js'

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const HOST_PORT = 18448
const HS = `http://localhost:${HOST_PORT}`

let workDir: string
let svc: TuwunelService

describe.skipIf(!dockerAvailable())(
  'zooid dev — bootstrap + tuwunel + admin',
  () => {
    beforeAll(async () => {
      workDir = mkdtempSync(join(tmpdir(), 'zooid-dev-'))
      const dataDir = join(workDir, 'data', 'matrix')
      const paths = resolvePaths(dataDir)
      const tokens = ensureTokens(paths.envPath)
      writeBootstrapConfigs({
        paths,
        serverName: 'localhost',
        asToken: tokens.asToken,
        hsToken: tokens.hsToken,
        senderLocalpart: 'zooid',
        userNamespace: '@.*:localhost',
      })
      svc = new TuwunelService({
        name: `zooid-tuwunel-test-${Date.now()}`,
        hostPort: HOST_PORT,
        paths,
        engine: 'docker',
      })
      await svc.start()
      await svc.waitHealthy({ url: HS, timeoutMs: 60_000 })
    }, 90_000)

    afterAll(async () => {
      await svc?.stop().catch(() => {})
      rmSync(workDir, { recursive: true, force: true })
    })

    it('writes tokens, tuwunel.toml, and the AS yaml under the data dir', () => {
      const dataDir = join(workDir, 'data', 'matrix')
      const env = readFileSync(join(dataDir, 'config', '.env'), 'utf8')
      expect(env).toMatch(/MATRIX_AS_TOKEN=as-[0-9a-f]+/)
      const toml = readFileSync(join(dataDir, 'config', 'tuwunel.toml'), 'utf8')
      expect(toml).toContain('server_name = "localhost"')
      const reg = readFileSync(
        join(dataDir, 'config', 'registrations', 'zooid.yaml'),
        'utf8',
      )
      expect(reg).toContain('id: zooid')
      expect(reg).toContain("regex: '@.*:localhost'")
    })

    it('boots Tuwunel and serves /_matrix/client/versions', async () => {
      const r = await fetch(`${HS}/_matrix/client/versions`)
      expect(r.ok).toBe(true)
      const body = (await r.json()) as { versions: string[] }
      expect(Array.isArray(body.versions)).toBe(true)
    })

    it('idempotently registers admin:admin and lets them log in', async () => {
      const first = await ensureAdminUser({
        homeserver: HS,
        username: 'admin',
        password: 'admin',
      })
      expect(first.created).toBe(true)
      expect(first.userId).toBe('@admin:localhost')

      const second = await ensureAdminUser({
        homeserver: HS,
        username: 'admin',
        password: 'admin',
      })
      expect(second.created).toBe(false)

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
      const j = (await login.json()) as { access_token: string }
      expect(j.access_token).toBeTruthy()
    })
  },
  120_000,
)
