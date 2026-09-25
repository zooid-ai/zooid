import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AcpClient } from './acp-client.js'

type Modes = { currentModeId: string; availableModes: Array<{ id: string; name: string }> } | null

const CLAUDE_MODES = [
  { id: 'default', name: 'Manual' },
  { id: 'acceptEdits', name: 'Accept edits' },
  { id: 'bypassPermissions', name: 'Bypass permissions' },
]

function makeStubbedClient(opts: {
  agentDataDir: string
  mode?: string
  loadSessionCapability?: boolean
  newSessionModes?: Modes
  loadSessionModes?: Modes
}) {
  const newSession = vi.fn(async () => ({
    sessionId: 'sess_new',
    modes: opts.newSessionModes,
  }))
  const loadSession = vi.fn(async () => ({ modes: opts.loadSessionModes }))
  const setSessionMode = vi.fn(async () => ({}))
  const fakeConnection = { newSession, loadSession, setSessionMode }

  const client = new AcpClient({
    agent: { id: 'cpo', command: '/bin/true', mode: opts.mode },
    agentDataDir: opts.agentDataDir,
    onEvent: () => {},
    onApprovalRequest: async () => ({ decision: 'cancel' }),
  })
  ;(client as unknown as { connection: typeof fakeConnection }).connection = fakeConnection
  ;(client as unknown as { initialized: boolean }).initialized = true
  ;(client as unknown as { agentCapabilities: { loadSession?: boolean } }).agentCapabilities = {
    loadSession: opts.loadSessionCapability ?? false,
  }
  return { client, newSession, loadSession, setSessionMode }
}

describe('AcpClient session mode', () => {
  let agentDataDir: string
  beforeEach(async () => {
    agentDataDir = await mkdtemp(join(tmpdir(), 'acpclient-mode-'))
  })
  afterEach(async () => {
    await rm(agentDataDir, { recursive: true, force: true })
  })

  it('switches a new session into the configured mode', async () => {
    const { client, setSessionMode } = makeStubbedClient({
      agentDataDir,
      mode: 'bypassPermissions',
      newSessionModes: { currentModeId: 'default', availableModes: CLAUDE_MODES },
    })
    await client.ensureSession('$root1')
    expect(setSessionMode).toHaveBeenCalledWith({
      sessionId: 'sess_new',
      modeId: 'bypassPermissions',
    })
  })

  it('does not call set_mode when the session already starts in the configured mode', async () => {
    const { client, setSessionMode } = makeStubbedClient({
      agentDataDir,
      mode: 'bypassPermissions',
      newSessionModes: { currentModeId: 'bypassPermissions', availableModes: CLAUDE_MODES },
    })
    await client.ensureSession('$root1')
    expect(setSessionMode).not.toHaveBeenCalled()
  })

  it('re-applies the mode to a session resumed via loadSession', async () => {
    {
      const a = makeStubbedClient({
        agentDataDir,
        mode: 'bypassPermissions',
        loadSessionCapability: true,
        newSessionModes: { currentModeId: 'default', availableModes: CLAUDE_MODES },
      })
      await a.client.ensureSession('$root1')
      await (a.client as unknown as { flushStore: () => Promise<void> }).flushStore()
    }
    const b = makeStubbedClient({
      agentDataDir,
      mode: 'bypassPermissions',
      loadSessionCapability: true,
      loadSessionModes: { currentModeId: 'default', availableModes: CLAUDE_MODES },
    })
    await b.client.ensureSession('$root1')
    expect(b.loadSession).toHaveBeenCalledTimes(1)
    expect(b.setSessionMode).toHaveBeenCalledWith({
      sessionId: 'sess_new',
      modeId: 'bypassPermissions',
    })
  })

  it('fails loudly, listing the offered modes, when the adapter does not offer the mode', async () => {
    const { client, setSessionMode } = makeStubbedClient({
      agentDataDir,
      mode: 'full-access',
      newSessionModes: { currentModeId: 'default', availableModes: CLAUDE_MODES },
    })
    await expect(client.ensureSession('$root1')).rejects.toThrow(
      /acp\.mode "full-access".*default, acceptEdits, bypassPermissions/,
    )
    expect(setSessionMode).not.toHaveBeenCalled()
  })

  it('fails loudly when the adapter reports no session modes at all', async () => {
    const { client } = makeStubbedClient({
      agentDataDir,
      mode: 'bypassPermissions',
      newSessionModes: null,
    })
    await expect(client.ensureSession('$root1')).rejects.toThrow(
      /acp\.mode "bypassPermissions".*does not offer session modes/,
    )
  })

  it('does not cache a session whose mode could not be applied', async () => {
    const { client, newSession } = makeStubbedClient({
      agentDataDir,
      mode: 'full-access',
      newSessionModes: { currentModeId: 'default', availableModes: CLAUDE_MODES },
    })
    await expect(client.ensureSession('$root1')).rejects.toThrow()
    await expect(client.ensureSession('$root1')).rejects.toThrow()
    expect(newSession).toHaveBeenCalledTimes(2)
  })

  it('leaves the adapter default alone when no mode is configured', async () => {
    const { client, setSessionMode } = makeStubbedClient({
      agentDataDir,
      newSessionModes: { currentModeId: 'default', availableModes: CLAUDE_MODES },
    })
    await client.ensureSession('$root1')
    expect(setSessionMode).not.toHaveBeenCalled()
  })
})
