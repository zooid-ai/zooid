import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { buildRunArgs } from '../services/tuwunel.js'
import { captureChildToFile } from './capture-tuwunel.js'

const base = {
  name: 'zooid-tuwunel',
  hostPort: 8448,
  paths: {
    dataDir: '/abs/data/matrix',
    dbDir: '/abs/data/matrix/db',
    mediaDir: '/abs/data/matrix/media',
    configDir: '/abs/data/matrix/config',
    registrationsDir: '/abs/data/matrix/config/registrations',
    tuwunelTomlPath: '/abs/data/matrix/config/tuwunel.toml',
    appserviceYamlPath: '/abs/data/matrix/config/registrations/zooid.yaml',
    envPath: '/abs/data/matrix/config/.env',
  },
} as const

describe('buildRunArgs (post-floor)', () => {
  it('no longer includes -d; container is foregrounded so the parent owns its stdio', () => {
    const args = buildRunArgs({ ...base, engine: 'docker' })
    expect(args).not.toContain('-d')
    expect(args).toContain('--rm')
    expect(args).toContain('--name')
  })
})

describe('captureChildToFile', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zooid-obs-tw-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('tees stdout AND stderr of a child to the same log file in arrival order', async () => {
    const path = join(dir, 'tuwunel.log')
    const child = spawn(
      process.execPath,
      ['-e', 'process.stdout.write("alpha\\n"); process.stderr.write("beta\\n");'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const done = captureChildToFile(child, path)
    await new Promise<void>((r) => child.on('exit', () => r()))
    await done
    const text = await readFile(path, 'utf8')
    expect(text).toContain('alpha')
    expect(text).toContain('beta')
  })
})
