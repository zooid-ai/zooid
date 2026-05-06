import { describe, it, expect, vi } from 'vitest'
import { AcpClient } from './acp-client.js'

describe('AcpClient.cancel', () => {
  it('forwards to the underlying ClientSideConnection.cancel with the sessionId', async () => {
    const fakeCancel = vi.fn(async () => {})
    const fakeConnection = { cancel: fakeCancel }
    const client = new AcpClient({
      agent: { id: 'a', command: 'noop', args: [] },
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'cancel' }),
    })
    // Skip start(); install the connection directly.
    ;(client as unknown as { connection: typeof fakeConnection }).connection = fakeConnection
    ;(client as unknown as { initialized: boolean }).initialized = true
    await client.cancel('sess-abc')
    expect(fakeCancel).toHaveBeenCalledWith({ sessionId: 'sess-abc' })
  })

  it('is a no-op (does not throw) when never started', async () => {
    const client = new AcpClient({
      agent: { id: 'a', command: 'noop', args: [] },
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'cancel' }),
    })
    await expect(client.cancel('sess-abc')).resolves.toBeUndefined()
  })

  it('is idempotent — second cancel for the same sessionId is forwarded again without error', async () => {
    const fakeCancel = vi.fn(async () => {})
    const client = new AcpClient({
      agent: { id: 'a', command: 'noop', args: [] },
      onEvent: () => {},
      onApprovalRequest: async () => ({ decision: 'cancel' }),
    })
    ;(client as unknown as { connection: { cancel: typeof fakeCancel } }).connection = {
      cancel: fakeCancel,
    }
    ;(client as unknown as { initialized: boolean }).initialized = true
    await client.cancel('sess-abc')
    await client.cancel('sess-abc')
    expect(fakeCancel).toHaveBeenCalledTimes(2)
  })
})
