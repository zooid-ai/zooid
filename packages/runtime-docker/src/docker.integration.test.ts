import { describe, it, expect } from 'vitest'
import { DockerRuntime } from './docker.js'
import type { AgentAdapter } from '@zooid/budd-core'

function adapter(envPassthrough: string[]): AgentAdapter {
  return {
    name: 'stub',
    envPassthrough,
    isAvailable: () => true,
    prepareNewSession: () => ({ strategy: 'preassigned', session_id: 'x' }),
    spawn: () => ({ command: 'true', args: [] }),
  }
}

describe('DockerRuntime — env passthrough integration', () => {
  it('forwards adapter envPassthrough into argv', () => {
    const rt = new DockerRuntime({
      image: 'stub:latest',
      workdir: '/tmp',
      adapter: adapter(['ANTHROPIC_API_KEY']),
      processEnv: { ANTHROPIC_API_KEY: 'sk-a' },
    })
    const argv = rt.buildArgv({ command: 'claude', args: ['-p', 'hi'] })
    expect(argv).toContain('ANTHROPIC_API_KEY=sk-a')
  })

  it('forwards forward_env entries from spawn config-time options', () => {
    const rt = new DockerRuntime({
      image: 'stub:latest',
      workdir: '/tmp',
      adapter: adapter([]),
      forwardEnv: ['JIRA_URL'],
      processEnv: { JIRA_URL: 'https://j' },
    })
    const argv = rt.buildArgv({ command: 'true', args: [] })
    expect(argv).toContain('JIRA_URL=https://j')
  })

  it('does NOT forward BUDD_TOKEN even if user lists it in forward_env', () => {
    const rt = new DockerRuntime({
      image: 'stub:latest',
      workdir: '/tmp',
      adapter: adapter([]),
      forwardEnv: ['BUDD_TOKEN'],
      processEnv: { BUDD_TOKEN: 'must-not-leak' },
    })
    const argv = rt.buildArgv({ command: 'true', args: [] })
    expect(argv.find((a) => a.startsWith('BUDD_TOKEN='))).toBeUndefined()
  })

  it('forwards synthetic per-session vars (SESSION_ID etc.) via SpawnConfig.env', () => {
    const rt = new DockerRuntime({
      image: 'stub:latest',
      workdir: '/tmp',
      adapter: adapter(['ANTHROPIC_API_KEY']),
      processEnv: { ANTHROPIC_API_KEY: 'sk-' },
    })
    const argv = rt.buildArgv({
      command: 'true',
      args: [],
      env: { SESSION_ID: '01JX', MESSAGE_TEXT: 'hi', WORKDIR: '/workspace' },
    })
    expect(argv).toContain('SESSION_ID=01JX')
    expect(argv).toContain('MESSAGE_TEXT=hi')
    expect(argv).toContain('WORKDIR=/workspace')
  })
})
