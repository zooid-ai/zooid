import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPiExtension, resolvePiAgentDir } from './pi-extension-install.js'

const dirs: string[] = []
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'zooid-pi-')); dirs.push(dir); return dir }
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

describe('resolvePiAgentDir', () => {
  it('resolves a relative PI_CODING_AGENT_DIR against each agent workdir', () => {
    expect(
      resolvePiAgentDir({
        agentWorkdir: '/proj/agents/alice',
        daemonHome: '/home/op',
        env: { PI_CODING_AGENT_DIR: '.pi-agent' },
      }),
    ).toEqual({ dir: '/proj/agents/alice/.pi-agent', scope: 'project' })
  })

  it('honours an absolute override and falls back to the operator home', () => {
    expect(
      resolvePiAgentDir({
        agentWorkdir: '/proj/agents/alice',
        daemonHome: '/home/op',
        env: { PI_CODING_AGENT_DIR: '/shared/pi' },
      }),
    ).toEqual({ dir: '/shared/pi', scope: 'project' })
    expect(
      resolvePiAgentDir({ agentWorkdir: '/proj/agents/alice', daemonHome: '/home/op', env: {} }),
    ).toEqual({ dir: '/home/op/.pi/agent', scope: 'home' })
  })
})

describe('installPiExtension', () => {
  it('only installs into an existing Pi home and preserves other extensions', () => {
    const home = scratch(); const source = join(scratch(), 'bundle.js')
    writeFileSync(source, '// bundle')
    const agentDir = join(home, '.pi', 'agent')
    expect(installPiExtension({ agentDir, bundlePath: source })).toMatchObject({ status: 'skipped' })
    expect(existsSync(join(home, '.pi'))).toBe(false)
    const extensions = join(agentDir, 'extensions')
    mkdirSync(extensions, { recursive: true }); writeFileSync(join(extensions, 'user.js'), '// user')
    expect(installPiExtension({ agentDir, bundlePath: source })).toMatchObject({ status: 'installed' })
    expect(readFileSync(join(extensions, 'zooid-tasks.js'), 'utf8')).toBe('// bundle')
    expect(readFileSync(join(extensions, 'user.js'), 'utf8')).toBe('// user')
    expect(installPiExtension({ agentDir, bundlePath: source })).toMatchObject({ status: 'unchanged' })
  })

  it('creates a project agent dir that does not exist yet', () => {
    const workdir = scratch(); const source = join(scratch(), 'bundle.js')
    writeFileSync(source, '// bundle')
    const { dir } = resolvePiAgentDir({
      agentWorkdir: workdir,
      daemonHome: '/home/op',
      env: { PI_CODING_AGENT_DIR: '.pi-agent' },
    })
    expect(installPiExtension({ agentDir: dir, bundlePath: source, createMissing: true })).toMatchObject({
      status: 'installed',
      target: join(workdir, '.pi-agent', 'extensions', 'zooid-tasks.js'),
    })
    expect(readFileSync(join(workdir, '.pi-agent', 'extensions', 'zooid-tasks.js'), 'utf8')).toBe('// bundle')
  })
})
