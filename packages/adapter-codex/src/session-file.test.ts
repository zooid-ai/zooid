import { describe, it, expect } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findCodexSessionFile,
  isCodexSessionBusy,
  tailCodexSessionFile,
  lineToEvent,
} from './session-file.js'
import type { SessionEvent } from '@zooid/core'

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build a fake Codex session file under a temp HOME and return the path.
 * Codex layout: ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<UUID>.jsonl
 */
function makeFakeSession(
  id: string,
  initialLines: string[] = [],
  dateDir = '2026/04/12',
): { home: string; filePath: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
  const dir = join(home, '.codex', 'sessions', ...dateDir.split('/'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `rollout-2026-04-12T00-00-00Z-${id}.jsonl`)
  writeFileSync(
    filePath,
    initialLines.map((l) => l + '\n').join(''),
    'utf8',
  )
  return {
    home,
    filePath,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

// ─── Fixture lines (on-disk JSONL format) ────────────────────────────────
//
// Codex on-disk lines have { timestamp, type, payload } wrappers — distinct
// from the stdout JSONL shape.

const SESSION_META = JSON.stringify({
  timestamp: '2026-04-12T00:00:00Z',
  type: 'session_meta',
  payload: {
    id: 'test-uuid',
    cwd: '/workspace',
    originator: 'codex_exec',
  },
})

const TASK_STARTED = JSON.stringify({
  timestamp: '2026-04-12T00:00:01Z',
  type: 'event_msg',
  payload: { type: 'task_started', turn_id: 'turn-1' },
})

const TASK_COMPLETE = JSON.stringify({
  timestamp: '2026-04-12T00:00:10Z',
  type: 'event_msg',
  payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'done' },
})

const TURN_ABORTED = JSON.stringify({
  timestamp: '2026-04-12T00:00:05Z',
  type: 'event_msg',
  payload: { type: 'turn_aborted', reason: 'interrupted' },
})

const TOKEN_COUNT = JSON.stringify({
  timestamp: '2026-04-12T00:00:02Z',
  type: 'event_msg',
  payload: { type: 'token_count', input: 100, output: 50 },
})

const RESPONSE_ITEM = JSON.stringify({
  timestamp: '2026-04-12T00:00:03Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
  },
})

const USER_MESSAGE = JSON.stringify({
  timestamp: '2026-04-12T00:00:00Z',
  type: 'event_msg',
  payload: { type: 'user_message', message: 'fix the bug' },
})

const TASK_STARTED_B = JSON.stringify({
  timestamp: '2026-04-12T00:01:00Z',
  type: 'event_msg',
  payload: { type: 'task_started', turn_id: 'turn-2' },
})

const TASK_COMPLETE_B = JSON.stringify({
  timestamp: '2026-04-12T00:01:10Z',
  type: 'event_msg',
  payload: { type: 'task_complete', turn_id: 'turn-2', last_agent_message: 'done' },
})

// ─── lineToEvent ─────────────────────────────────────────────────────────

describe('lineToEvent', () => {
  it('returns null for empty lines', () => {
    expect(lineToEvent('')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(lineToEvent('not json')).toBeNull()
  })

  it('filters token_count noise', () => {
    expect(lineToEvent(TOKEN_COUNT)).toBeNull()
  })

  it('forwards session_meta as stdout', () => {
    const ev = lineToEvent(SESSION_META)
    expect(ev).toMatchObject({ type: 'stdout' })
  })

  it('forwards event_msg task_started as stdout', () => {
    const ev = lineToEvent(TASK_STARTED)
    expect(ev).toMatchObject({ type: 'stdout' })
  })

  it('forwards response_item as stdout', () => {
    const ev = lineToEvent(RESPONSE_ITEM)
    expect(ev).toMatchObject({ type: 'stdout' })
  })
})

// ─── findCodexSessionFile ────────────────────────────────────────────────

describe('findCodexSessionFile', () => {
  it('finds a session file by UUID suffix', async () => {
    const { home, filePath, cleanup } = makeFakeSession('find-me-uuid')
    try {
      const found = await findCodexSessionFile('find-me-uuid', home)
      expect(found).toBe(filePath)
    } finally {
      cleanup()
    }
  })

  it('returns null when no file matches', async () => {
    const { home, cleanup } = makeFakeSession('exists-uuid')
    try {
      const found = await findCodexSessionFile('no-such-uuid', home)
      expect(found).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('returns null when sessions dir does not exist', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-empty-'))
    try {
      const found = await findCodexSessionFile('any-uuid', home)
      expect(found).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('finds a file across multiple date dirs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-multi-'))
    const dir1 = join(home, '.codex', 'sessions', '2026', '04', '11')
    const dir2 = join(home, '.codex', 'sessions', '2026', '04', '12')
    mkdirSync(dir1, { recursive: true })
    mkdirSync(dir2, { recursive: true })
    const target = join(dir2, 'rollout-2026-04-12T00-00-00Z-target-uuid.jsonl')
    writeFileSync(join(dir1, 'rollout-2026-04-11T00-00-00Z-other-uuid.jsonl'), '', 'utf8')
    writeFileSync(target, '', 'utf8')
    try {
      const found = await findCodexSessionFile('target-uuid', home)
      expect(found).toBe(target)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// ─── tailCodexSessionFile ────────────────────────────────────────────────

describe('tailCodexSessionFile', () => {
  it('returns null when the file does not exist', async () => {
    const stream = await tailCodexSessionFile('/no/such/file.jsonl')
    expect(stream).toBeNull()
  })

  it('replays existing lines, filtering noise', async () => {
    const { filePath, cleanup } = makeFakeSession('tail-1', [
      TOKEN_COUNT,
      SESSION_META,
      TASK_STARTED,
      RESPONSE_ITEM,
    ])
    try {
      const stream = await tailCodexSessionFile(filePath, { pollMs: 10 })
      expect(stream).not.toBeNull()
      const collected: SessionEvent[] = []
      const iter = stream![Symbol.asyncIterator]()
      // TOKEN_COUNT is filtered; expect 3 events.
      for (let i = 0; i < 3; i++) {
        const r = await iter.next()
        if (r.done) break
        collected.push(r.value)
      }
      await iter.return!()
      expect(collected).toHaveLength(3)
      expect(collected.every((e) => e.type === 'stdout')).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('live-tails newly appended lines', async () => {
    const { filePath, cleanup } = makeFakeSession('tail-2', [SESSION_META])
    try {
      const stream = await tailCodexSessionFile(filePath, { pollMs: 10 })
      const iter = stream![Symbol.asyncIterator]()

      const first = await iter.next()
      expect(first.done).toBe(false)
      expect((first.value as { chunks: string[] }).chunks[0]).toContain(
        '"session_meta"',
      )

      appendFileSync(filePath, TASK_STARTED + '\n', 'utf8')
      const second = await iter.next()
      expect(second.done).toBe(false)
      expect((second.value as { chunks: string[] }).chunks[0]).toContain(
        '"task_started"',
      )

      await iter.return!()
    } finally {
      cleanup()
    }
  })

  it('honors AbortSignal', async () => {
    const { filePath, cleanup } = makeFakeSession('tail-3', [SESSION_META])
    try {
      const ac = new AbortController()
      const stream = await tailCodexSessionFile(filePath, {
        pollMs: 10000,
        signal: ac.signal,
      })
      const iter = stream![Symbol.asyncIterator]()

      const first = await iter.next()
      expect(first.done).toBe(false)

      const pendingNext = iter.next()
      setTimeout(() => ac.abort(), 20)
      const result = await pendingNext
      expect(result.done).toBe(true)
    } finally {
      cleanup()
    }
  })
})

// ─── isCodexSessionBusy ─────────────────────────────────────────────────
//
// Fixtures mirror real on-disk shapes from killing live codex runs.

describe('isCodexSessionBusy', () => {
  it('returns false when the file does not exist', async () => {
    expect(await isCodexSessionBusy('/no/such/file.jsonl')).toBe(false)
  })

  it('returns false for an empty file', async () => {
    const { filePath, cleanup } = makeFakeSession('busy-empty', [])
    try {
      expect(await isCodexSessionBusy(filePath)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('clean exit (task_complete) → idle', async () => {
    const { filePath, cleanup } = makeFakeSession('busy-clean', [
      SESSION_META,
      TASK_STARTED,
      RESPONSE_ITEM,
      TASK_COMPLETE,
    ])
    try {
      expect(await isCodexSessionBusy(filePath)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('SIGPIPE (turn_aborted) → idle', async () => {
    const { filePath, cleanup } = makeFakeSession('busy-sigpipe', [
      SESSION_META,
      TASK_STARTED,
      TURN_ABORTED,
    ])
    try {
      expect(await isCodexSessionBusy(filePath)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('mid-turn busy (task_started, no task_complete) → busy', async () => {
    const { filePath, cleanup } = makeFakeSession('busy-mid', [
      SESSION_META,
      TASK_STARTED,
      RESPONSE_ITEM,
    ])
    try {
      expect(await isCodexSessionBusy(filePath)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('multi-turn idle: both turns completed → idle', async () => {
    const { filePath, cleanup } = makeFakeSession('busy-multi-idle', [
      SESSION_META,
      TASK_STARTED,
      TASK_COMPLETE,
      USER_MESSAGE,
      TASK_STARTED_B,
      TASK_COMPLETE_B,
    ])
    try {
      expect(await isCodexSessionBusy(filePath)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('multi-turn busy: first completed, second in flight → busy', async () => {
    const { filePath, cleanup } = makeFakeSession('busy-multi-busy', [
      SESSION_META,
      TASK_STARTED,
      TASK_COMPLETE,
      USER_MESSAGE,
      TASK_STARTED_B,
      RESPONSE_ITEM,
    ])
    try {
      expect(await isCodexSessionBusy(filePath)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('SIGKILL (task_started, no terminal marker) → busy (accepted gap)', async () => {
    const { filePath, cleanup } = makeFakeSession('busy-sigkill', [
      SESSION_META,
      TASK_STARTED,
    ])
    try {
      expect(await isCodexSessionBusy(filePath)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('skips trailing corrupted JSON line and uses prior verdict', async () => {
    const { filePath, cleanup } = makeFakeSession('busy-corrupt', [
      SESSION_META,
      TASK_STARTED,
      TASK_COMPLETE,
      'not-even-json-truncated-mid-write',
    ])
    try {
      expect(await isCodexSessionBusy(filePath)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('returns false when no event_msg lines exist (only session_meta)', async () => {
    const { filePath, cleanup } = makeFakeSession('busy-meta-only', [
      SESSION_META,
    ])
    try {
      expect(await isCodexSessionBusy(filePath)).toBe(false)
    } finally {
      cleanup()
    }
  })
})
