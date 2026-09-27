import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpClient } from './acp-client.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  vi.useRealTimers()
})

function clientAt(dir: string, choice: 'resume' | 'load' | 'new') {
  const sent: unknown[] = []
  const connection = {
    newSession: vi.fn(async () => ({ sessionId: 'stored' })),
    resumeSession: vi.fn(async () => ({})),
    loadSession: vi.fn(async () => ({})),
    closeSession: vi.fn(async () => ({})),
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' as const })),
    cancel: vi.fn(async () => {}),
  }
  const client = new AcpClient({
    agent: { id: 'architect', command: '/bin/true' },
    agentDataDir: dir,
    sessionIdleTimeoutMs: 0,
    onEvent: (event) => { sent.push(event) },
    onApprovalRequest: async () => ({ decision: 'cancel' }),
  })
  Object.assign(client as object, {
    connection,
    initialized: true,
    agentCapabilities: {
      loadSession: choice !== 'new',
      sessionCapabilities: {
        close: {},
        ...(choice === 'resume' ? { resume: {} } : {}),
      },
    },
  })
  return { client, connection, sent }
}

describe('persisted ACP lifecycle', () => {
  it('keeps the pointer on idle close, prefers resume, and deletes it on clear', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zod089-'))
    dirs.push(dir)
    const a = clientAt(dir, 'resume')
    await a.client.prompt({ threadId: 'root', content: [{ type: 'text', text: 'one' }] })
    await a.client.closeIdleSession('root')
    expect(a.connection.closeSession).toHaveBeenCalledWith({ sessionId: 'stored' })
    const b = clientAt(dir, 'resume')
    await b.client.ensureSession('root')
    expect(b.connection.resumeSession).toHaveBeenCalledTimes(1)
    await b.client.endSession('root')
    const c = clientAt(dir, 'resume')
    await c.client.ensureSession('root')
    expect(c.connection.resumeSession).not.toHaveBeenCalled()
    expect(c.connection.newSession).toHaveBeenCalledTimes(1)
    await Promise.all([a.client.stop(), b.client.stop(), c.client.stop()])
  })

  it('suppresses replay on load but allows the next prompt update', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zod089-'))
    dirs.push(dir)
    const a = clientAt(dir, 'resume')
    await a.client.ensureSession('root')
    const b = clientAt(dir, 'load')
    const callbacks = (b.client as unknown as {
      buildClient: () => { sessionUpdate: (value: unknown) => Promise<void> }
    }).buildClient()
    b.connection.loadSession.mockImplementationOnce(async () => {
      await callbacks.sessionUpdate({
        sessionId: 'stored',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'history' } },
      })
      await callbacks.sessionUpdate({
        sessionId: 'unrelated',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'concurrent' } },
      })
      return {}
    })
    await b.client.ensureSession('root')
    expect(b.sent).toHaveLength(1)
    await callbacks.sessionUpdate({
      sessionId: 'stored',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'new' } },
    })
    expect(b.sent).toHaveLength(2)
    await Promise.all([a.client.stop(), b.client.stop()])
  })
})
