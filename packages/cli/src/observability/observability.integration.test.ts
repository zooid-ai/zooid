import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { wireAgentCapture } from './capture-agent.js'
import { resolveLogPaths, ensureDayFolder } from './paths.js'
import type { TapEvent } from '@zooid/core'

describe('agent capture end-to-end', () => {
  let dataDir: string
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'zooid-obs-int-'))
  })
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('captures lifecycle identity and counts only successful reclamation', async () => {
    const now = new Date('2026-05-06T10:00:00Z')
    const paths = resolveLogPaths({ dataDir, now })
    await ensureDayFolder(paths)
    const cap = wireAgentCapture({ agent: 'docs', paths, verbosity: 'default', matrixContext: () => null, now: () => now })
    cap.onLifecycle({ agentId: 'docs', sessionKey: 'root', sessionId: 's1', outcome: 'recovered', recoveryMethod: 'new' })
    cap.onLifecycle({ agentId: 'docs', sessionKey: 'root', sessionId: 's1', reason: 'idle', outcome: 'closed' })
    cap.onLifecycle({ agentId: 'docs', sessionKey: 'root', sessionId: 's1', outcome: 'recovered', recoveryMethod: 'resume' })
    cap.onLifecycle({ agentId: 'docs', sessionKey: 'root', sessionId: 's1', reason: 'clear', outcome: 'failed' })
    expect(cap.readLifecycleCounters()).toEqual({
      closeAttempts: 2,
      closeSuccesses: 1,
      sessionsReclaimed: 1,
      recoveries: { cached: 0, resume: 1, load: 0, new: 1 },
    })
    await cap.close()
    const rows = (await readFile(paths.agentTap('docs'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(rows).toHaveLength(4)
    expect(rows[1]).toMatchObject({ kind: 'session_lifecycle', session_key: 'root', session_id: 's1', reason: 'idle', outcome: 'closed' })
    expect(rows[1]).not.toHaveProperty('prompt_text')
  })

  it('writes one JSONL line per tap event with envelope + turn correlation', async () => {
    const now = new Date('2026-05-06T10:00:00Z')
    const paths = resolveLogPaths({ dataDir, now })
    await ensureDayFolder(paths)

    const cap = wireAgentCapture({
      agent: 'docs',
      paths,
      verbosity: 'default',
      matrixContext: () => ({ room_id: '!abc:localhost', event_id: '$xyz' }),
      now: () => now,
    })

    const events: TapEvent[] = [
      {
        kind: 'turn_started',
        agentId: 'docs',
        sessionId: 'sess_1',
        turnId: 'turn_1',
        promptText: 'write the overview page',
      },
      {
        kind: 'session_update',
        agentId: 'docs',
        sessionId: 'sess_1',
        turnId: 'turn_1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc_1',
          kind: 'edit',
          title: 'edit overview.md',
        } as never,
      },
      {
        kind: 'session_update',
        agentId: 'docs',
        sessionId: 'sess_1',
        turnId: 'turn_1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc_1',
          status: 'completed',
        } as never,
      },
      {
        kind: 'session_update',
        agentId: 'docs',
        sessionId: 'sess_1',
        turnId: 'turn_1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'done' },
        } as never,
      },
      {
        kind: 'turn_completed',
        agentId: 'docs',
        sessionId: 'sess_1',
        turnId: 'turn_1',
        stopReason: 'end_turn',
      },
    ]
    for (const e of events) cap.onTap(e)
    await cap.close()

    const text = await readFile(paths.agentTap('docs'), 'utf8')
    const lines = text.trim().split('\n').map((l) => JSON.parse(l))

    expect(lines.map((l) => l.kind)).toEqual([
      'turn_started',
      'session_update',
      'session_update',
      'turn_completed',
    ])
    for (const l of lines) {
      expect(l.ts).toBe('2026-05-06T10:00:00.000Z')
      expect(l.agent).toBe('docs')
      expect(l.session_id).toBe('sess_1')
      expect(l.turn_id).toBe('turn_1')
      expect(l.matrix).toEqual({ room_id: '!abc:localhost', event_id: '$xyz' })
    }
  })

  it('thought chunks are dropped by default but kept under verbose-thoughts', async () => {
    const paths = resolveLogPaths({ dataDir, now: new Date('2026-05-06T10:00:00Z') })
    await ensureDayFolder(paths)
    const cap = wireAgentCapture({
      agent: 'docs',
      paths,
      verbosity: 'verbose-thoughts',
      matrixContext: () => null,
      now: () => new Date('2026-05-06T10:00:00Z'),
    })
    cap.onTap({
      kind: 'session_update',
      agentId: 'docs',
      sessionId: 's',
      turnId: 't',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking…' },
      } as never,
    })
    cap.onTap({
      kind: 'session_update',
      agentId: 'docs',
      sessionId: 's',
      turnId: 't',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'output' },
      } as never,
    })
    await cap.close()
    const lines = (await readFile(paths.agentTap('docs'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines).toHaveLength(1)
    expect(lines[0].notification.sessionUpdate).toBe('agent_thought_chunk')
  })

  it('omits matrix context cleanly when not running on Matrix', async () => {
    const paths = resolveLogPaths({ dataDir, now: new Date('2026-05-06T10:00:00Z') })
    await ensureDayFolder(paths)
    const cap = wireAgentCapture({
      agent: 'echo',
      paths,
      verbosity: 'default',
      matrixContext: () => null,
      now: () => new Date('2026-05-06T10:00:00Z'),
    })
    cap.onTap({
      kind: 'turn_started',
      agentId: 'echo',
      sessionId: 's',
      turnId: 't',
      promptText: 'ping',
    })
    await cap.close()
    const line = JSON.parse((await readFile(paths.agentTap('echo'), 'utf8')).trim())
    expect(line.matrix).toBeUndefined()
  })
})
