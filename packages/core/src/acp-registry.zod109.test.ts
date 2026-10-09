import { describe, it, expect, vi } from 'vitest'
import type { AcpRuntime } from './acp-types.js'
import type { AgentConfig } from './types.js'
import { AcpAgentRegistry } from './acp-registry.js'

const rt = (): AcpRuntime => ({ spawn: vi.fn() as never })

function agentCfg(name: string): AgentConfig {
  return {
    name,
    workdir: '.',
    hooks: {},
    acp: { command: 'noop' },
    approval_timeout_ms: 0,
    session_idle_timeout_ms: 0,
  }
}

describe('AcpAgentRegistry.runtimeFor (ZOD109)', () => {
  it('prefers the per-agent runtime', () => {
    const shared = rt()
    const vm = rt()
    const reg = new AcpAgentRegistry({
      runtime: shared,
      runtimeByAgent: { smoke: vm },
      agents: { lead: agentCfg('lead'), smoke: agentCfg('smoke') },
    })
    expect(reg.runtimeFor('smoke')).toBe(vm)
    expect(reg.runtimeFor('lead')).toBe(shared)
  })

  it('works with only a per-agent map', () => {
    const vm = rt()
    const reg = new AcpAgentRegistry({
      runtimeByAgent: { smoke: vm },
      agents: { smoke: agentCfg('smoke') },
    })
    expect(reg.runtimeFor('smoke')).toBe(vm)
  })

  it('throws for an agent with no runtime at all', () => {
    const reg = new AcpAgentRegistry({ agents: { smoke: agentCfg('smoke') } })
    expect(() => reg.runtimeFor('smoke')).toThrow(/no runtime for agent smoke/)
  })
})
