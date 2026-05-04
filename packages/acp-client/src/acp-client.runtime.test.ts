import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { AcpClient } from './acp-client.js'

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} })
  stdin = new Writable({ write(_c, _e, cb) { cb() } })
  stderr = new Readable({ read() {} })
  pid = 1
  kill = vi.fn(() => true)
}

describe('AcpClient honors a passed-in runtime', () => {
  it('delegates the spawn to the runtime when one is provided', () => {
    const child = new FakeChild() as unknown as ChildProcess
    const rt = { spawn: vi.fn().mockReturnValue(child) }
    const client = new AcpClient({
      agent: { id: 'x', command: 'foo', args: ['bar'], env: { K: 'v' }, cwd: '/x' },
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'cancel' }),
      runtime: rt,
    })
    void client.start().catch(() => {})
    expect(rt.spawn).toHaveBeenCalledTimes(1)
    expect(rt.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'foo',
        args: ['bar'],
        env: { K: 'v' },
        cwd: '/x',
      }),
    )
  })

  it('resolves a preset before passing to the runtime', () => {
    const child = new FakeChild() as unknown as ChildProcess
    const rt = { spawn: vi.fn().mockReturnValue(child) }
    const client = new AcpClient({
      agent: { id: 'c', preset: 'claude' },
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'cancel' }),
      runtime: rt,
    })
    void client.start().catch(() => {})
    const arg = rt.spawn.mock.calls[0][0]
    expect(arg.command).toBe('npx')
    expect(arg.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp'])
  })
})
