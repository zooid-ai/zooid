import { describe, it, expect } from 'vitest'
import { LocalAcpRuntime } from '@zooid/runtime-local'
import { DockerAcpRuntime } from '@zooid/runtime-docker'
import type { WorkforceConfig } from '@zooid/core'
import { buildAcpRegistry } from './build-registry.js'

function cfg(overrides: Partial<WorkforceConfig> & Pick<WorkforceConfig, 'runtime'>): WorkforceConfig {
  return {
    runtime: overrides.runtime,
    transports: overrides.transports ?? { 'http-local': { type: 'http', port: 8080 } },
    agents: overrides.agents ?? {
      a: {
        name: 'a',
        transport: 'http-local',
        workdir: '.',
        hooks: {},
        acp: { preset: 'claude' },
        approval_timeout_ms: 0,
      },
    },
    hooks: {},
    docker: overrides.docker,
  } as WorkforceConfig
}

describe('buildAcpRegistry', () => {
  it('constructs with LocalAcpRuntime for runtime: local', () => {
    const reg = buildAcpRegistry(cfg({ runtime: 'local' }))
    expect((reg as unknown as { opts: { runtime: unknown } }).opts.runtime).toBeInstanceOf(LocalAcpRuntime)
  })

  it('constructs with DockerAcpRuntime (docker engine) for runtime: docker', () => {
    const reg = buildAcpRegistry(
      cfg({ runtime: 'docker', docker: { image: 'img:latest' } }),
    )
    const rt = (reg as unknown as { opts: { runtime: DockerAcpRuntime } }).opts.runtime
    expect(rt).toBeInstanceOf(DockerAcpRuntime)
  })

  it('constructs with DockerAcpRuntime (podman engine) for runtime: podman', () => {
    const reg = buildAcpRegistry(
      cfg({ runtime: 'podman', docker: { image: 'img:latest' } }),
    )
    const rt = (reg as unknown as { opts: { runtime: DockerAcpRuntime } }).opts.runtime
    expect(rt).toBeInstanceOf(DockerAcpRuntime)
  })

  it('computes per-agent forwardEnv from docker.forward_env (pass-through and rename)', () => {
    process.env.HOST_API_KEY = 'sk-host'
    process.env.PASS_THROUGH = 'p'
    try {
      const reg = buildAcpRegistry(
        cfg({
          runtime: 'docker',
          docker: { image: 'img' },
          agents: {
            a: {
              name: 'a',
              transport: 'http-local',
              workdir: '.',
              hooks: {},
              acp: { preset: 'claude' },
              approval_timeout_ms: 0,
              docker: {
                forward_env: ['PASS_THROUGH', 'HOST_API_KEY:ANTHROPIC_API_KEY'],
              },
            },
          },
        }),
      )
      const fwd = (reg as unknown as { opts: { forwardEnv: Record<string, Record<string, string>> } }).opts.forwardEnv
      expect(fwd.a).toEqual({
        PASS_THROUGH: 'p',
        ANTHROPIC_API_KEY: 'sk-host',
      })
    } finally {
      delete process.env.HOST_API_KEY
      delete process.env.PASS_THROUGH
    }
  })

  it('blocks ZOOID_* unconditionally on either side of a rename', () => {
    process.env.ZOOID_TOKEN = 'never'
    process.env.SOMETHING = 'ok'
    try {
      const reg = buildAcpRegistry(
        cfg({
          runtime: 'docker',
          docker: { image: 'img' },
          agents: {
            a: {
              name: 'a',
              transport: 'http-local',
              workdir: '.',
              hooks: {},
              acp: { preset: 'claude' },
              approval_timeout_ms: 0,
              docker: {
                forward_env: ['ZOOID_TOKEN', 'SOMETHING:ZOOID_TOKEN'],
              },
            },
          },
        }),
      )
      const fwd = (reg as unknown as { opts: { forwardEnv: Record<string, Record<string, string>> } }).opts.forwardEnv
      expect(fwd.a.ZOOID_TOKEN).toBeUndefined()
    } finally {
      delete process.env.ZOOID_TOKEN
      delete process.env.SOMETHING
    }
  })

  it('throws if any agent has no acp block (defense in depth)', () => {
    const c: WorkforceConfig = {
      runtime: 'local',
      transports: { 'http-local': { type: 'http', port: 8080 } },
      agents: {
        a: { name: 'a', transport: 'http-local', workdir: '.', hooks: {} } as never,
      },
      hooks: {},
    }
    expect(() => buildAcpRegistry(c)).toThrow(/agents\.a.*acp/i)
  })
})
