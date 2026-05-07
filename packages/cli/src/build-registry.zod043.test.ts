import { describe, it, expect } from 'vitest'
import { buildAcpRegistry } from './build-registry.js'
import type { WorkforceConfig } from '@zooid/core'

const baseTransports = {
  m1: {
    type: 'matrix' as const,
    homeserver: 'http://localhost:8448',
    as_token: 't',
    hs_token: 'h',
    sender_localpart: 'z',
    user_namespace: '@.*:localhost',
  },
}

function makeCfg(over: Partial<WorkforceConfig> = {}): WorkforceConfig {
  return {
    runtime: 'docker',
    container: { image: 'workforce-default:1' },
    transports: baseTransports,
    agents: {
      alice: {
        name: 'alice',
        workdir: './alice',
        hooks: {},
        acp: { preset: 'claude' },
        approval_timeout_ms: 0,
        matrix: {
          transport: 'm1',
          user_id: '@alice:localhost',
          rooms: ['!r:localhost'],
          trigger: 'mention',
        },
        container: { env: { LOG_LEVEL: 'info' } },
      },
    },
    hooks: {},
    ...over,
  }
}

describe('buildAcpRegistry — ZOD043', () => {
  it('passes agent.container.env through as the spawn env (no forward_env layer)', () => {
    const cfg = makeCfg()
    const reg = buildAcpRegistry(cfg)
    expect(reg.resolveSpawnEnv('alice')).toEqual({ LOG_LEVEL: 'info' })
  })

  it('resolves image with per-agent override beating workforce default', () => {
    const cfg = makeCfg()
    cfg.agents.alice!.container = {
      ...cfg.agents.alice!.container,
      image: 'alice:2',
    }
    const reg = buildAcpRegistry(cfg)
    expect(reg.resolveSpawnImage('alice')).toBe('alice:2')
  })

  it('falls back to workforce container.image when no per-agent image', () => {
    const cfg = makeCfg()
    const reg = buildAcpRegistry(cfg)
    expect(reg.resolveSpawnImage('alice')).toBe('workforce-default:1')
  })
})
