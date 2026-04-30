import { describe, it, expect } from 'vitest'
import { PodmanRuntime } from './podman.js'

const baseOpts = {
  image: 'ghcr.io/zooid-ai/budd-agent-claude-code:latest',
  workdir: '/workspace',
  adapter: {
    name: 'claude',
    envPassthrough: ['ANTHROPIC_API_KEY'],
    workspaceReadOnly: [],
    homeReadOnly: [],
    sessionStateDir: (cwd: string) => `.claude/projects/${cwd.replace(/\//g, '-')}`,
    isAvailable: () => true,
    prepareNewSession: () => ({ strategy: 'preassigned' as const, session_id: 'test-id' }),
    spawn: () => ({ command: 'claude', args: [] }),
    openStream: () => null,
    isSessionBusy: () => false,
  },
  processEnv: { ANTHROPIC_API_KEY: 'sk-test' },
}

const baseSpawnConfig = {
  command: 'claude',
  args: ['-p', 'hello'],
  env: {},
}

describe('PodmanRuntime — bare metal', () => {
  const runtime = new PodmanRuntime(baseOpts)

  it('argv starts with run', () => {
    expect(runtime.buildArgv(baseSpawnConfig)[0]).toBe('run')
  })

  it('does NOT include --cgroups=disabled', () => {
    expect(runtime.buildArgv(baseSpawnConfig)).not.toContain('--cgroups=disabled')
  })

  it('does NOT include --network=host', () => {
    expect(runtime.buildArgv(baseSpawnConfig)).not.toContain('--network=host')
  })

  it('does NOT include seccomp=unconfined', () => {
    expect(runtime.buildArgv(baseSpawnConfig).join(' ')).not.toContain('seccomp=unconfined')
  })

  it('does NOT include --ulimit', () => {
    expect(runtime.buildArgv(baseSpawnConfig).indexOf('--ulimit')).toBe(-1)
  })

  it('includes the image', () => {
    expect(runtime.buildArgv(baseSpawnConfig)).toContain(
      'ghcr.io/zooid-ai/budd-agent-claude-code:latest',
    )
  })

  it('has containerized = true', () => {
    expect(runtime.containerized).toBe(true)
  })
})
