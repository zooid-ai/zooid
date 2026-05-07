import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, existsSync } from 'node:fs'
import { resolveDataLayout } from '../bootstrap/data-layout.js'
import { resolvePaths } from '../bootstrap/paths.js'
import { writeBootstrapConfigs } from '../bootstrap/configs.js'

// This test exercises the *layout boundary*: given a data root, the bootstrap
// helpers write matrix-specific files under <root>/matrix/ and never elsewhere.
// It does not boot tuwunel.

describe('dev bootstrap honours the data-root layout', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'zooid-dev-layout-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes tuwunel.toml + appservice.yaml under <root>/matrix/, agents/ stays empty', () => {
    const layout = resolveDataLayout(root)
    const paths = resolvePaths(layout.matrixDir)
    writeBootstrapConfigs({
      paths,
      serverName: 'localhost',
      asToken: 'as-token',
      hsToken: 'hs-token',
      senderLocalpart: 'zooid',
      userNamespace: '@.*:localhost',
    })

    // Matrix-side files exist where expected.
    expect(existsSync(join(root, 'matrix', 'config', 'tuwunel.toml'))).toBe(true)
    expect(
      existsSync(join(root, 'matrix', 'config', 'registrations', 'zooid.yaml')),
    ).toBe(true)
    expect(existsSync(join(root, 'matrix', 'db'))).toBe(true)
    expect(existsSync(join(root, 'matrix', 'media'))).toBe(true)

    // Crucially: nothing writes to <root>/matrix/logs or <root>/matrix/agents.
    expect(existsSync(join(root, 'matrix', 'logs'))).toBe(false)
    expect(existsSync(join(root, 'matrix', 'agents'))).toBe(false)

    // agents/ is reserved for ZOD028 and not pre-created by bootstrap.
    expect(existsSync(join(root, 'agents'))).toBe(false)
  })

  it('agentDir(id) resolves a deterministic path even before the dir exists', () => {
    const layout = resolveDataLayout(root)
    expect(layout.agentDir('docs')).toBe(join(root, 'agents', 'docs'))
  })
})
