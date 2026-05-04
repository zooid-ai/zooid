import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { AcpRuntime, AcpSpawnSpec } from './acp-types.js'

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} })
  stdin = new Writable({ write(_c, _e, cb) { cb() } })
  stderr = new Readable({ read() {} })
  pid = 1
  kill = vi.fn(() => true)
}

class StubRuntime implements AcpRuntime {
  spawn = vi.fn((_: AcpSpawnSpec) => new FakeChild() as unknown as ReturnType<AcpRuntime['spawn']>)
}

vi.mock('@zooid/acp-client', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    AcpClient: vi.fn().mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
      stop: vi.fn().mockResolvedValue(undefined),
    })),
  }
})

const { AcpAgentRegistry } = await import('./acp-registry.js')

describe('AcpAgentRegistry', () => {
  let runtime: StubRuntime
  let registry: InstanceType<typeof AcpAgentRegistry>

  beforeEach(async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    AcpClient.mockClear()
    runtime = new StubRuntime()
    registry = new AcpAgentRegistry({
      runtime,
      agents: {
        triage: {
          name: 'triage',
          workdir: '.',
          hooks: {},
          acp: { preset: 'claude' },
        },
        builder: {
          name: 'builder',
          workdir: '.',
          hooks: {},
          acp: { command: 'opencode', args: ['acp'] },
        },
      },
      forwardEnv: { triage: { ANTHROPIC_API_KEY: 'sk-test' } },
    })
  })

  it('throws on prompt() for an unknown agent', async () => {
    await expect(
      registry.prompt('nope', { threadId: 't', content: [] }),
    ).rejects.toThrow(/unknown agent/i)
  })

  it('hasAgent reflects config keys', () => {
    expect(registry.hasAgent('triage')).toBe(true)
    expect(registry.hasAgent('nope')).toBe(false)
  })

  it('lazily starts a client on first prompt', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    expect(AcpClient).not.toHaveBeenCalled()
    await registry.prompt('triage', { threadId: 't1', content: [] })
    expect(AcpClient).toHaveBeenCalledTimes(1)
  })

  it('reuses the same client across prompts (long-lived)', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    await registry.prompt('triage', { threadId: 't1', content: [] })
    await registry.prompt('triage', { threadId: 't2', content: [] })
    expect(AcpClient).toHaveBeenCalledTimes(1)
  })

  it('keeps clients per-agent isolated', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    await registry.prompt('triage', { threadId: 't', content: [] })
    await registry.prompt('builder', { threadId: 't', content: [] })
    expect(AcpClient).toHaveBeenCalledTimes(2)
  })

  it('passes preset → AcpClient via @zooid/acp-client preset registry', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    await registry.prompt('triage', { threadId: 't', content: [] })
    const opts = AcpClient.mock.calls[0][0]
    expect(opts.agent.command).toBe('npx')
    expect(opts.agent.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp'])
  })

  it('passes explicit command/args through', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    await registry.prompt('builder', { threadId: 't', content: [] })
    const opts = AcpClient.mock.calls[0][0]
    expect(opts.agent.command).toBe('opencode')
    expect(opts.agent.args).toEqual(['acp'])
  })

  it('passes per-agent forwardEnv into AcpClient.agent.env', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    await registry.prompt('triage', { threadId: 't', content: [] })
    const opts = AcpClient.mock.calls[0][0]
    expect(opts.agent.env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-test' })
  })

  it('threads the AcpRuntime into AcpClient', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    await registry.prompt('triage', { threadId: 't', content: [] })
    const opts = AcpClient.mock.calls[0][0]
    expect(opts.runtime).toBe(runtime)
  })

  it('stopAll() invokes stop on every started client', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    await registry.prompt('triage', { threadId: 't', content: [] })
    await registry.stopAll()
    const inst = AcpClient.mock.results[0].value as { stop: ReturnType<typeof vi.fn> }
    expect(inst.stop).toHaveBeenCalled()
  })
})
