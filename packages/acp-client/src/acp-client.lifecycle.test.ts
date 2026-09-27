import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AcpClient } from './acp-client.js'

const dirs: string[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(options: {
  timeout?: number
  close?: boolean
  resume?: boolean
  load?: boolean
  prompt?: () => Promise<{ stopReason: 'end_turn' }>
  approval?: () => Promise<{ decision: 'cancel' }>
} = {}) {
  const connection = {
    newSession: vi.fn(async () => ({ sessionId: 's1' })),
    resumeSession: vi.fn(async () => ({})),
    loadSession: vi.fn(async () => ({})),
    closeSession: vi.fn(async () => ({})),
    cancel: vi.fn(async () => {}),
    prompt: vi.fn(options.prompt ?? (async () => ({ stopReason: 'end_turn' as const }))),
  }
  const events: unknown[] = []
  const lifecycle: unknown[] = []
  const agentDataDir = mkdtempSync(join(tmpdir(), 'zod089-unit-'))
  dirs.push(agentDataDir)
  const client = new AcpClient({
    agent: { id: 'architect', command: '/bin/true' },
    agentDataDir,
    sessionIdleTimeoutMs: options.timeout ?? 1000,
    onEvent: (event) => { events.push(event) },
    onApprovalRequest: options.approval ?? (async () => ({ decision: 'cancel' })),
    onLifecycle: (event) => { lifecycle.push(event) },
  })
  Object.assign(client as object, {
    connection,
    initialized: true,
    agentCapabilities: {
      loadSession: options.load ?? true,
      sessionCapabilities: {
        ...(options.close === false ? {} : { close: {} }),
        ...(options.resume === false ? {} : { resume: {} }),
      },
    },
  })
  return { client, connection, events, lifecycle }
}

const input = (threadId: string) => ({
  threadId,
  content: [{ type: 'text' as const, text: 'hello' }],
})

describe('ACP session lifecycle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('closes an idle session, retains continuity, then resumes the same id', async () => {
    const { client, connection, lifecycle } = fixture()
    await client.prompt(input('root'))
    await vi.advanceTimersByTimeAsync(999)
    expect(connection.closeSession).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(connection.closeSession).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(lifecycle).toContainEqual(expect.objectContaining({
      agentId: 'architect',
      sessionKey: 'root',
      sessionId: 's1',
      reason: 'idle',
      outcome: 'closed',
    }))
    await client.prompt(input('root'))
    expect(connection.resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', mcpServers: [] }),
    )
    expect(connection.newSession).toHaveBeenCalledTimes(1)
    await client.stop()
  })

  it('does not close during a prompt or pending human request', async () => {
    const turn = deferred<{ stopReason: 'end_turn' }>()
    const { client, connection } = fixture({ prompt: () => turn.promise })
    const running = client.prompt(input('root'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(connection.closeSession).not.toHaveBeenCalled()
    client.setHumanRequestPending('root', true)
    turn.resolve({ stopReason: 'end_turn' })
    await running
    await vi.advanceTimersByTimeAsync(2000)
    expect(connection.closeSession).not.toHaveBeenCalled()
    client.setHumanRequestPending('root', false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(connection.closeSession).toHaveBeenCalledTimes(1)
    await client.stop()
  })

  it('holds an idle session while an ACP permission awaits a decision', async () => {
    const decision = deferred<{ decision: 'cancel' }>()
    const { client, connection } = fixture({ approval: () => decision.promise })
    await client.prompt(input('root'))
    const callbacks = (client as unknown as {
      buildClient: () => { requestPermission: (value: unknown) => Promise<unknown> }
    }).buildClient()
    const pending = callbacks.requestPermission({
      sessionId: 's1',
      toolCall: { toolCallId: 'tc1', title: 'edit' },
      options: [{ optionId: 'no', name: 'Cancel', kind: 'reject_once' }],
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(connection.closeSession).not.toHaveBeenCalled()
    decision.resolve({ decision: 'cancel' })
    await pending
    await vi.advanceTimersByTimeAsync(1000)
    expect(connection.closeSession).toHaveBeenCalledTimes(1)
    await client.stop()
  })

  it('falls from failed resume to load, then from failed load to new', async () => {
    const { client, connection } = fixture()
    await client.prompt(input('root'))
    await client.closeIdleSession('root')
    connection.resumeSession.mockRejectedValueOnce(new Error('not active'))
    await client.prompt(input('root'))
    expect(connection.loadSession).toHaveBeenCalledTimes(1)
    await client.closeIdleSession('root')
    connection.resumeSession.mockRejectedValueOnce(new Error('not active'))
    connection.loadSession.mockRejectedValueOnce(new Error('missing'))
    connection.newSession.mockResolvedValueOnce({ sessionId: 's2' })
    await client.prompt(input('root'))
    expect(connection.newSession).toHaveBeenCalledTimes(2)
    await client.stop()
  })

  it('keeps unsupported sessions resident and warns once', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, connection } = fixture({ close: false })
    await client.prompt(input('root'))
    await vi.advanceTimersByTimeAsync(1000)
    await client.prompt(input('root'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(connection.closeSession).not.toHaveBeenCalled()
    expect(connection.newSession).toHaveBeenCalledTimes(1)
    expect(warning).toHaveBeenCalledTimes(1)
    await client.stop()
  })

  it('keeps sessions resident when the adapter can close but not resume or load', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, connection } = fixture({ resume: false, load: false })
    await client.prompt(input('root'))
    await vi.advanceTimersByTimeAsync(1000)
    await client.prompt(input('root'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(connection.closeSession).not.toHaveBeenCalled()
    expect(connection.newSession).toHaveBeenCalledTimes(1)
    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning.mock.calls[0]![0]).toMatch(/cannot resume or load/)
    await client.stop()
  })

  it('still closes idle sessions when the adapter can only load', async () => {
    const { client, connection } = fixture({ resume: false })
    await client.prompt(input('root'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(connection.closeSession).toHaveBeenCalledTimes(1)
    await client.prompt(input('root'))
    expect(connection.loadSession).toHaveBeenCalledTimes(1)
    await client.stop()
  })

  it('forgets a cleared session even when close fails', async () => {
    const { client, connection } = fixture()
    await client.prompt(input('root'))
    connection.closeSession.mockRejectedValueOnce(new Error('lost response'))
    await client.endSession('root')
    connection.newSession.mockResolvedValueOnce({ sessionId: 's2' })
    await client.prompt(input('root'))
    expect(connection.resumeSession).not.toHaveBeenCalled()
    expect(connection.newSession).toHaveBeenCalledTimes(2)
    await client.stop()
  })

  it('serializes a prompt behind an already claimed close for the same key', async () => {
    const gate = deferred<Record<string, never>>()
    const { client, connection } = fixture()
    await client.prompt(input('root'))
    connection.closeSession.mockImplementationOnce(() => gate.promise)
    const closing = client.endSession('root')
    const next = client.prompt(input('root'))
    await Promise.resolve()
    expect(connection.newSession).toHaveBeenCalledTimes(1)
    connection.newSession.mockResolvedValueOnce({ sessionId: 's2' })
    gate.resolve({})
    await closing
    await next
    expect(connection.newSession).toHaveBeenCalledTimes(2)
    await client.stop()
  })

  it('disables idle close with zero while explicit clear still closes', async () => {
    const { client, connection } = fixture({ timeout: 0 })
    await client.prompt(input('root'))
    await vi.advanceTimersByTimeAsync(100_000)
    expect(connection.closeSession).not.toHaveBeenCalled()
    await client.endSession('root')
    expect(connection.closeSession).toHaveBeenCalledTimes(1)
    await client.stop()
  })

  it('coalesces simultaneous session setup and closes one key without blocking another', async () => {
    const gate = deferred<Record<string, never>>()
    const { client, connection } = fixture()
    const [first, second] = await Promise.all([client.ensureSession('root'), client.ensureSession('root')])
    expect(first).toBe(second)
    expect(connection.newSession).toHaveBeenCalledTimes(1)
    connection.closeSession.mockImplementationOnce(() => gate.promise)
    const closing = client.closeIdleSession('root')
    const nextRoot = client.prompt(input('root'))
    const other = client.prompt(input('other'))
    await other
    expect(connection.prompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }))
    expect(connection.resumeSession).not.toHaveBeenCalled()
    gate.resolve({})
    await closing
    await nextRoot
    expect(connection.resumeSession).toHaveBeenCalledTimes(1)
    await client.stop()
  })

  it('cancels a pending permission on reset and forgets the pointer', async () => {
    const decision = deferred<{ decision: 'cancel' }>()
    const { client, connection } = fixture({ approval: () => decision.promise })
    await client.ensureSession('root')
    const callbacks = (client as unknown as {
      buildClient: () => { requestPermission: (value: unknown) => Promise<unknown> }
    }).buildClient()
    const pending = callbacks.requestPermission({
      sessionId: 's1', toolCall: { toolCallId: 'tc1', title: 'edit' },
      options: [{ optionId: 'no', name: 'Cancel', kind: 'reject_once' }],
    })
    await client.endSession('root')
    await expect(pending).resolves.toEqual(expect.objectContaining({ outcome: expect.anything() }))
    expect(connection.closeSession).toHaveBeenCalledTimes(1)
    connection.newSession.mockResolvedValueOnce({ sessionId: 's2' })
    await client.prompt(input('root'))
    expect(connection.newSession).toHaveBeenCalledTimes(2)
    await client.stop()
  })

  it('waits for a cancelled turn to finish before closing its session', async () => {
    const turn = deferred<{ stopReason: 'end_turn' }>()
    const { client, connection } = fixture({ prompt: () => turn.promise })
    const running = client.prompt(input('root'))
    await vi.waitFor(() => expect(connection.prompt).toHaveBeenCalledTimes(1))
    connection.cancel.mockImplementationOnce(async () => {
      expect(connection.closeSession).not.toHaveBeenCalled()
      turn.resolve({ stopReason: 'end_turn' })
    })
    await client.endSession('root')
    await running
    expect(connection.cancel).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(connection.closeSession).toHaveBeenCalledWith({ sessionId: 's1' })
    await client.stop()
  })
})
