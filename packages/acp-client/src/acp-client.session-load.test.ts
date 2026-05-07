import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AcpClient } from './acp-client.js'

function makeStubbedClient(opts: {
  agentDataDir: string
  agentId: string
  loadSessionCapability: boolean
  newSessionImpl?: () => Promise<{ sessionId: string }>
  loadSessionImpl?: (req: { sessionId: string }) => Promise<unknown>
}) {
  const newSession = vi.fn(opts.newSessionImpl ?? (async () => ({ sessionId: 'sess_new' })))
  const loadSession = vi.fn(
    opts.loadSessionImpl ?? (async () => ({})),
  )
  const fakeConnection = {
    initialize: vi.fn(async () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: opts.loadSessionCapability },
    })),
    newSession,
    loadSession,
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
    cancel: vi.fn(async () => {}),
  }

  const client = new AcpClient({
    agent: { id: opts.agentId, command: '/bin/true' },
    agentDataDir: opts.agentDataDir,
    onEvent: () => {},
    onApprovalRequest: async () => ({ decision: 'cancel' }),
  })
  ;(client as unknown as { connection: typeof fakeConnection }).connection = fakeConnection
  ;(client as unknown as { initialized: boolean }).initialized = true
  ;(client as unknown as { agentCapabilities: { loadSession?: boolean } }).agentCapabilities = {
    loadSession: opts.loadSessionCapability,
  }
  return { client, fakeConnection, newSession, loadSession }
}

describe('AcpClient.ensureSession resume', () => {
  let agentDataDir: string
  beforeEach(async () => {
    agentDataDir = await mkdtemp(join(tmpdir(), 'acpclient-ensure-'))
  })
  afterEach(async () => {
    await import('node:fs/promises').then((fs) => fs.rm(agentDataDir, { recursive: true, force: true }))
  })

  it('first call mints via newSession and persists the id', async () => {
    const { client, newSession, loadSession } = makeStubbedClient({
      agentDataDir,
      agentId: 'docs',
      loadSessionCapability: true,
      newSessionImpl: async () => ({ sessionId: 'sess_first' }),
    })
    await (client as unknown as { ensureStoreLoaded: () => Promise<void> }).ensureStoreLoaded()

    const id = await client.ensureSession('$root1')
    expect(id).toBe('sess_first')
    expect(newSession).toHaveBeenCalledTimes(1)
    expect(loadSession).not.toHaveBeenCalled()
  })

  it('a fresh AcpClient on the same agent data dir resumes via loadSession when capability is on', async () => {
    {
      const a = makeStubbedClient({
        agentDataDir,
        agentId: 'docs',
        loadSessionCapability: true,
        newSessionImpl: async () => ({ sessionId: 'sess_persist' }),
      })
      await (a.client as unknown as { ensureStoreLoaded: () => Promise<void> }).ensureStoreLoaded()
      await a.client.ensureSession('$root1')
    }

    const b = makeStubbedClient({
      agentDataDir,
      agentId: 'docs',
      loadSessionCapability: true,
    })
    await (b.client as unknown as { ensureStoreLoaded: () => Promise<void> }).ensureStoreLoaded()

    const id = await b.client.ensureSession('$root1')
    expect(id).toBe('sess_persist')
    expect(b.loadSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess_persist' }),
    )
    expect(b.newSession).not.toHaveBeenCalled()
  })

  it('skips loadSession when the agent does not advertise the capability', async () => {
    {
      const a = makeStubbedClient({
        agentDataDir,
        agentId: 'docs',
        loadSessionCapability: false,
        newSessionImpl: async () => ({ sessionId: 'sess_one' }),
      })
      await (a.client as unknown as { ensureStoreLoaded: () => Promise<void> }).ensureStoreLoaded()
      await a.client.ensureSession('$root1')
    }

    const b = makeStubbedClient({
      agentDataDir,
      agentId: 'docs',
      loadSessionCapability: false,
      newSessionImpl: async () => ({ sessionId: 'sess_two' }),
    })
    await (b.client as unknown as { ensureStoreLoaded: () => Promise<void> }).ensureStoreLoaded()

    const id = await b.client.ensureSession('$root1')
    expect(id).toBe('sess_two')
    expect(b.loadSession).not.toHaveBeenCalled()
    expect(b.newSession).toHaveBeenCalledTimes(1)
  })

  it('falls back to newSession when loadSession rejects, and clears the stored id', async () => {
    {
      const a = makeStubbedClient({
        agentDataDir,
        agentId: 'docs',
        loadSessionCapability: true,
        newSessionImpl: async () => ({ sessionId: 'sess_old' }),
      })
      await (a.client as unknown as { ensureStoreLoaded: () => Promise<void> }).ensureStoreLoaded()
      await a.client.ensureSession('$root1')
    }

    const b = makeStubbedClient({
      agentDataDir,
      agentId: 'docs',
      loadSessionCapability: true,
      loadSessionImpl: async () => {
        throw new Error('shim does not recognise this id')
      },
      newSessionImpl: async () => ({ sessionId: 'sess_replacement' }),
    })
    await (b.client as unknown as { ensureStoreLoaded: () => Promise<void> }).ensureStoreLoaded()

    const id = await b.client.ensureSession('$root1')
    expect(id).toBe('sess_replacement')
    expect(b.loadSession).toHaveBeenCalledTimes(1)
    expect(b.newSession).toHaveBeenCalledTimes(1)

    const c = makeStubbedClient({
      agentDataDir,
      agentId: 'docs',
      loadSessionCapability: true,
    })
    await (c.client as unknown as { ensureStoreLoaded: () => Promise<void> }).ensureStoreLoaded()
    const id3 = await c.client.ensureSession('$root1')
    expect(id3).toBe('sess_replacement')
    expect(c.loadSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess_replacement' }),
    )
  })

  it('endSession() also clears the persisted id', async () => {
    const { client } = makeStubbedClient({
      agentDataDir,
      agentId: 'docs',
      loadSessionCapability: true,
      newSessionImpl: async () => ({ sessionId: 'sess_one' }),
    })
    await (client as unknown as { ensureStoreLoaded: () => Promise<void> }).ensureStoreLoaded()
    await client.ensureSession('$root1')
    client.endSession('$root1')
    await (client as unknown as { flushStore: () => Promise<void> }).flushStore()

    const fresh = makeStubbedClient({
      agentDataDir,
      agentId: 'docs',
      loadSessionCapability: true,
      newSessionImpl: async () => ({ sessionId: 'sess_after_clear' }),
    })
    await (fresh.client as unknown as { ensureStoreLoaded: () => Promise<void> }).ensureStoreLoaded()
    const id = await fresh.client.ensureSession('$root1')
    expect(id).toBe('sess_after_clear')
    expect(fresh.loadSession).not.toHaveBeenCalled()
  })
})
