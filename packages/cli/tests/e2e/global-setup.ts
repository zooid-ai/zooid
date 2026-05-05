import { execSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDev, type DevHandle } from '../../src/commands/dev.js'

declare global {
  // eslint-disable-next-line no-var
  var __ZOOID_DEV__:
    | { workDir: string; dataDir: string; handle: DevHandle }
    | undefined
}

const HERE = dirname(fileURLToPath(import.meta.url))
const EXAMPLE_DIR = resolve(HERE, '..', '..', '..', '..', 'examples', 'zooid-dev')

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export default async function globalSetup(): Promise<void> {
  if (!dockerAvailable()) {
    throw new Error('Docker is required for the zooid dev e2e. Install Docker or skip this suite.')
  }
  // Don't `cp -R` the example folder — pnpm's symlinked node_modules become
  // dead under a different path and the echo shim's `node --import tsx`
  // resolution breaks. Run against the original example dir, override
  // workforce.yaml's hardcoded port via a temp config dir, and put data/
  // somewhere we can clean up.
  const dataDir = mkdtempSync(join(tmpdir(), 'zooid-e2e-data-'))
  const workDir = mkdtempSync(join(tmpdir(), 'zooid-e2e-cfg-'))
  const yamlPath = join(workDir, 'workforce.yaml')
  copyFileSync(join(EXAMPLE_DIR, 'workforce.yaml'), yamlPath)
  writeFileSync(
    yamlPath,
    readFileSync(yamlPath, 'utf8').replace(
      /http:\/\/localhost:8448/,
      'http://localhost:28448',
    ),
  )
  // Daemon spawns the echo shim with cwd resolved relative to process.cwd.
  // Chdir into the example so node finds tsx + the SDK in real node_modules.
  process.chdir(EXAMPLE_DIR)

  const handle = await runDev({
    cwd: workDir,
    dataDir,
    hostPort: 28448,
    uiPort: 25173,
    engine: 'docker',
    adminUser: 'admin',
    adminPassword: 'admin',
    installSignalHandlers: false,
    foreground: false,
  })
  globalThis.__ZOOID_DEV__ = { workDir, dataDir, handle }
}
