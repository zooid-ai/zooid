import { describe, expect, it, vi } from 'vitest'
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

describe('AcpClient onTap', () => {
  it('accepts an optional onTap option without breaking the existing surface', () => {
    const child = new FakeChild() as unknown as ChildProcess
    const rt = { spawn: vi.fn().mockReturnValue(child) }
    expect(() => {
      new AcpClient({
        agent: { id: 'x', command: 'foo', args: [] },
        onEvent: () => {},
        onApprovalRequest: async () => ({ decision: 'cancel' }),
        runtime: rt,
        // onTap is optional
      })
      new AcpClient({
        agent: { id: 'y', command: 'foo', args: [] },
        onEvent: () => {},
        onApprovalRequest: async () => ({ decision: 'cancel' }),
        runtime: rt,
        onTap: () => {},
      })
    }).not.toThrow()
  })
})
