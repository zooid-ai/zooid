import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { RequestError } from '@agentclientprotocol/sdk'
import { AcpClient } from './acp-client.js'
import type { TapEvent } from './turn-tracker.js'

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

describe('AcpClient — error TapEvent emission', () => {
  function makeClient(onTap: (e: TapEvent) => void) {
    const child = new FakeChild() as unknown as ChildProcess
    const rt = { spawn: vi.fn().mockReturnValue(child) }
    const client = new AcpClient({
      agent: { id: 'alice', command: 'foo', args: [] },
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'cancel' }),
      runtime: rt,
      onTap,
    })
    return client
  }

  it('emits {kind:"error",...} when prompt throws a RequestError', async () => {
    const seen: TapEvent[] = []
    const client = makeClient((e) => seen.push(e))

    const fakeConn = {
      newSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1' }),
      prompt: vi.fn().mockRejectedValue(
        new RequestError(-32000, 'Authentication required', undefined),
      ),
      loadSession: vi.fn(),
    }
    ;(client as unknown as Record<string, unknown>).connection = fakeConn
    ;(client as unknown as Record<string, unknown>).initialized = true

    await expect(
      client.prompt({ threadId: 'thread-1', content: [{ type: 'text', text: 'hi' }] }),
    ).rejects.toThrow()

    const errEvt = seen.find((e) => e.kind === 'error')
    expect(errEvt).toBeDefined()
    expect(errEvt!.code).toBe('auth_missing')
    expect(errEvt!.acp_error).toMatchObject({ code: -32000, message: 'Authentication required' })
    expect(errEvt!.sessionId).toBe('sess-1')
    expect(errEvt!.turnId).not.toBeNull()
  })

  it('emits with sessionId=null when ensureSession throws (newSession failure)', async () => {
    const seen: TapEvent[] = []
    const client = makeClient((e) => seen.push(e))

    const fakeConn = {
      newSession: vi.fn().mockRejectedValue(new Error('ACP connection closed')),
      prompt: vi.fn(),
      loadSession: vi.fn(),
    }
    ;(client as unknown as Record<string, unknown>).connection = fakeConn
    ;(client as unknown as Record<string, unknown>).initialized = true

    await expect(
      client.prompt({ threadId: 'thread-1', content: [{ type: 'text', text: 'hi' }] }),
    ).rejects.toThrow()

    const errEvt = seen.find((e) => e.kind === 'error')
    expect(errEvt).toBeDefined()
    expect(errEvt!.sessionId).toBeNull()
    expect(errEvt!.code).toBe('container_exit')
  })
})
