import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

const spawnMock = vi.fn()
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const { AcpClient } = await import('./acp-client.js')

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} })
  stdin = new Writable({
    write(_c, _e, cb) {
      cb()
    },
  })
  stderr = new Readable({ read() {} })
  pid = 99999
  kill = vi.fn(() => true)
}

describe('AcpClient preset support', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockReturnValue(new FakeChild())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('spawns the preset command/args when agent.preset is set', async () => {
    const client = new AcpClient({
      agent: { id: 'claude-1', preset: 'claude' },
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'cancel' }),
    })

    void client.start().catch(() => {})

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [cmd, args] = spawnMock.mock.calls[0]
    expect(cmd).toBe('npx')
    expect(args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp'])

    await client.stop()
  })

  it('still accepts explicit command/args (no preset)', async () => {
    const client = new AcpClient({
      agent: { id: 'opencode-1', command: 'opencode', args: ['acp'] },
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'cancel' }),
    })
    void client.start().catch(() => {})

    const [cmd, args] = spawnMock.mock.calls[0]
    expect(cmd).toBe('opencode')
    expect(args).toEqual(['acp'])
    await client.stop()
  })

  it('lets explicit command override a preset', async () => {
    const client = new AcpClient({
      agent: {
        id: 'claude-custom',
        preset: 'claude',
        command: '/usr/local/bin/my-claude-acp',
        args: ['--verbose'],
      },
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'cancel' }),
    })
    void client.start().catch(() => {})

    const [cmd, args] = spawnMock.mock.calls[0]
    expect(cmd).toBe('/usr/local/bin/my-claude-acp')
    expect(args).toEqual(['--verbose'])
    await client.stop()
  })

  it('throws if neither preset nor command is provided', async () => {
    const client = new AcpClient({
      // @ts-expect-error — missing both command and preset
      agent: { id: 'broken' },
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'cancel' }),
    })
    await expect(client.start()).rejects.toThrow(/preset.*or.*command/i)
  })

  it('throws on an unknown preset name', async () => {
    const client = new AcpClient({
      // @ts-expect-error — preset is typed to known names
      agent: { id: 'broken', preset: 'made-up' },
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'cancel' }),
    })
    await expect(client.start()).rejects.toThrow(/unknown ACP preset/i)
  })

  it('forwards env and cwd alongside a preset', async () => {
    const client = new AcpClient({
      agent: {
        id: 'claude-2',
        preset: 'claude',
        env: { ANTHROPIC_API_KEY: 'sk-test' },
        cwd: '/workspace',
      },
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'cancel' }),
    })
    void client.start().catch(() => {})

    const [, , options] = spawnMock.mock.calls[0]
    expect(options.env.ANTHROPIC_API_KEY).toBe('sk-test')
    expect(options.cwd).toBe('/workspace')
    await client.stop()
  })
})
