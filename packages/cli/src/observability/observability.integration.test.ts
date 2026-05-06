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
