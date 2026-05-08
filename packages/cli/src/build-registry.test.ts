import { describe, it, expect } from 'vitest'
import { LocalAcpRuntime } from '@zooid/runtime-local'
import { DockerAcpRuntime } from '@zooid/runtime-docker'
import type { ZooidConfig } from '@zooid/core'
import { buildAcpRegistry } from './build-registry.js'

function cfg(overrides: Partial<ZooidConfig> & Pick<ZooidConfig, 'runtime'>): ZooidConfig {
  return {
    runtime: overrides.runtime,
    transports: overrides.transports ?? { 'http-local': { type: 'http', port: 8080 } },
    agents: overrides.agents ?? {
      a: {
        name: 'a',
        workdir: '.',
        hooks: {},
        acp: { preset: 'claude' },
        approval_timeout_ms: 0,
        http: { transport: 'http-local' },
      },
    },
    hooks: {},
    container: overrides.container,
  } as ZooidConfig
}

describe('buildAcpRegistry', () => {
  it('constructs with LocalAcpRuntime for runtime: local', () => {
    const reg = buildAcpRegistry(cfg({ runtime: 'local' }))
    expect((reg as unknown as { opts: { runtime: unknown } }).opts.runtime).toBeInstanceOf(LocalAcpRuntime)
  })

  it('constructs with DockerAcpRuntime (docker engine) for runtime: docker', () => {
    const reg = buildAcpRegistry(
      cfg({ runtime: 'docker', container: { image: 'img:latest' } }),
    )
    const rt = (reg as unknown as { opts: { runtime: DockerAcpRuntime } }).opts.runtime
    expect(rt).toBeInstanceOf(DockerAcpRuntime)
  })

  it('constructs with DockerAcpRuntime (podman engine) for runtime: podman', () => {
    const reg = buildAcpRegistry(
      cfg({ runtime: 'podman', container: { image: 'img:latest' } }),
    )
    const rt = (reg as unknown as { opts: { runtime: DockerAcpRuntime } }).opts.runtime
    expect(rt).toBeInstanceOf(DockerAcpRuntime)
  })

  it('throws if any agent has no acp block (defense in depth)', () => {
    const c: ZooidConfig = {
      runtime: 'local',
      transports: { 'http-local': { type: 'http', port: 8080 } },
      agents: {
        a: { name: 'a', workdir: '.', hooks: {}, http: { transport: 'http-local' } } as never,
      },
      hooks: {},
    }
    expect(() => buildAcpRegistry(c)).toThrow(/agents\.a.*acp/i)
  })
})
