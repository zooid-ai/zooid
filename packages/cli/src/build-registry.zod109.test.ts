import { describe, it, expect } from 'vitest'
import { LocalAcpRuntime } from '@zooid/runtime-local'
import { DockerAcpRuntime } from '@zooid/runtime-docker'
import { VmAcpRuntime, vmMachineName } from '@zooid/runtime-vm'
import { PRESETS } from '@zooid/acp-client'
import type { AgentConfig, ZooidConfig } from '@zooid/core'
import {
  buildAcpRegistry,
  containerAgentNames,
  contextEligibleAgents,
  contextUnavailableAgents,
} from './build-registry.js'

const CONFIG_DIR = '/tmp/zod109-workforce'

function agent(name: string, over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    workdir: `./agents/${name}`,
    hooks: {},
    acp: { command: 'node', args: ['agent.mjs'] },
    approval_timeout_ms: 0,
    session_idle_timeout_ms: 0,
    http: { transport: 'http-local' },
    ...over,
  }
}

function cfg(agents: Record<string, AgentConfig>, over: Partial<ZooidConfig> = {}): ZooidConfig {
  return {
    runtime: 'local',
    transports: {
      'http-local': { type: 'http', port: 8080 },
      matrix: { type: 'matrix', homeserver: 'http://hs', as_token: 'a', hs_token: 'h' } as never,
    },
    agents,
    hooks: {},
    ...over,
  } as ZooidConfig
}

describe('buildAcpRegistry — mixed fleet (ZOD109)', () => {
  const mixed = () =>
    cfg({
      lead: agent('lead'),
      coder: agent('coder', { runtime: 'docker', container: { image: 'img:1' } }),
      smoke: agent('smoke', { runtime: 'vm', vm: { image: 'node:22-alpine' } }),
    })

  it('gives each agent the runtime its resolved kind calls for', () => {
    const reg = buildAcpRegistry(mixed(), { configDir: CONFIG_DIR, log: () => {} })
    expect(reg.runtimeFor('lead')).toBeInstanceOf(LocalAcpRuntime)
    expect(reg.runtimeFor('coder')).toBeInstanceOf(DockerAcpRuntime)
    const vm = reg.runtimeFor('smoke') as VmAcpRuntime
    expect(vm).toBeInstanceOf(VmAcpRuntime)
    expect(vm.machine).toBe(vmMachineName('smoke', CONFIG_DIR))
  })

  it('a vm agent spawns in the guest workdir with no spawn-time mounts', () => {
    const reg = buildAcpRegistry(mixed(), { configDir: CONFIG_DIR, log: () => {} })
    expect(reg.resolveSpawnCwd('smoke')).toBe('/workspace')
    expect(reg.resolveSpawnMounts('smoke')).toEqual([])
    expect(reg.resolveSpawnImage('smoke')).toBe('node:22-alpine')
  })

  it('a docker agent in a local workforce still gets the workspace mount', () => {
    const reg = buildAcpRegistry(mixed(), { configDir: CONFIG_DIR, log: () => {} })
    expect(reg.resolveSpawnMounts('coder').map((m) => m.target)).toContain('/workspace')
    expect(reg.resolveSpawnCwd('lead')).toBe('./agents/lead')
  })

  it("a vm agent's image falls back to its preset's, never to the workforce container image", () => {
    const c = cfg(
      {
        coder: agent('coder', { runtime: 'docker' }),
        smoke: agent('smoke', { runtime: 'vm', acp: { preset: 'pi' } }),
      },
      { container: { image: 'workforce:1' } },
    )
    const reg = buildAcpRegistry(c, { configDir: CONFIG_DIR, log: () => {} })
    expect(reg.resolveSpawnImage('smoke')).toBe(PRESETS.pi!.image)
    expect(reg.resolveSpawnImage('coder')).toBe('workforce:1')
  })

  it('refuses a vm agent with no image to boot', () => {
    expect(() =>
      buildAcpRegistry(cfg({ smoke: agent('smoke', { runtime: 'vm' }) }), {
        configDir: CONFIG_DIR,
        log: () => {},
      }),
    ).toThrow(/runtime: vm requires an image[\s\S]*smoke[\s\S]*vm\.image/)
  })

  it('containerAgentNames lists only docker/podman agents (the prepull set)', () => {
    expect(containerAgentNames(mixed())).toEqual(['coder'])
  })
})

describe('context under vm (ZOD109)', () => {
  const matrixAgent = (name: string, over: Partial<AgentConfig> = {}) =>
    agent(name, {
      http: undefined,
      matrix: { transport: 'matrix', user_id: `@${name}:hs`, rooms: [], trigger: 'mention' } as never,
      ...over,
    })

  it('excludes vm agents from context eligibility and reports them as unavailable', () => {
    const c = cfg({
      lead: matrixAgent('lead'),
      smoke: matrixAgent('smoke', { runtime: 'vm', vm: { image: 'i' } }),
    })
    expect(contextEligibleAgents(c)).toEqual(['lead'])
    expect(contextUnavailableAgents(c)).toEqual(['smoke'])
  })
})
