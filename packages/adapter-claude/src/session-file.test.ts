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
  claudeSessionFilePath,
  isClaudeSessionBusy,
  tailClaudeSessionFile,
} from './session-file.js'
import type { SessionEvent } from '@zooid/core'

describe('claudeSessionFilePath', () => {
  it('encodes a leading-slash absolute path with leading dash', () => {
    expect(claudeSessionFilePath('abc-123', '/Users/ori/Code/z', '/HOME')).toBe(
      '/HOME/.claude/projects/-Users-ori-Code-z/abc-123.jsonl',
    )
  })

  it('encodes a single-segment path', () => {
    expect(claudeSessionFilePath('xyz', '/workspace', '/HOME')).toBe(
      '/HOME/.claude/projects/-workspace/xyz.jsonl',
    )
  })

  it('strips trailing slashes before encoding', () => {
    expect(claudeSessionFilePath('xyz', '/workspace/', '/HOME')).toBe(
      '/HOME/.claude/projects/-workspace/xyz.jsonl',
    )
  })
})

// Helper: build a fake claude session file under a temp HOME and return the
// path the adapter would compute for it.
function makeFakeSession(
  id: string,
  cwd: string,
  initialLines: string[] = [],
): { home: string; filePath: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'claude-home-'))
  const filePath = claudeSessionFilePath(id, cwd, home)
  mkdirSync(join(home, '.claude', 'projects', cwd.replace(/\//g, '-')), {
    recursive: true,
  })
  writeFileSync(
    filePath,
    initialLines.map((l) => l + '\n').join(''),
    'utf8',
  )
  return { home, filePath, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

// JSONL fixture lines mirroring what Claude Code actually writes.
const USER_LINE = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: 'fix the auth bug' },
  uuid: 'u-1',
  timestamp: '2026-04-12T00:00:00Z',
})
const ASSISTANT_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'looking at it' }],
    stop_reason: 'end_turn',
  },
  uuid: 'a-1',
  parentUuid: 'u-1',
  timestamp: '2026-04-12T00:00:01Z',
})
const QUEUE_LINE = JSON.stringify({
  type: 'queue-operation',
  operation: 'enqueue',
  sessionId: 'whatever',
})

describe('tailClaudeSessionFile', () => {
  it('returns null when the file does not exist', async () => {
    const { home, cleanup } = makeFakeSession('present', '/workspace', [])
    try {
      const missing = claudeSessionFilePath('absent', '/workspace', home)
      const stream = await tailClaudeSessionFile(missing)
      expect(stream).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('replays existing lines as stdout events, filtering queue-operation noise', async () => {
    const { filePath, cleanup } = makeFakeSession('s1', '/workspace', [
      QUEUE_LINE,
      USER_LINE,
      ASSISTANT_LINE,
    ])
    try {
      const stream = await tailClaudeSessionFile(filePath, { pollMs: 10 })
      expect(stream).not.toBeNull()
      const collected: SessionEvent[] = []
      const iter = stream![Symbol.asyncIterator]()
      // Pull two events (the queue line is filtered, leaving user + assistant).
      for (let i = 0; i < 2; i++) {
        const r = await iter.next()
        if (r.done) break
        collected.push(r.value)
      }
      // Done — close the iterator so the file handle is released.
      await iter.return!()

      expect(collected).toHaveLength(2)
      expect(collected[0]).toMatchObject({ type: 'stdout' })
      expect((collected[0] as { chunks: string[] }).chunks[0]).toContain(
        '"type":"user"',
      )
      expect((collected[1] as { chunks: string[] }).chunks[0]).toContain(
        '"type":"assistant"',
      )
    } finally {
      cleanup()
    }
  })

  it('live-tails newly appended lines after the initial replay', async () => {
    const { filePath, cleanup } = makeFakeSession('s2', '/workspace', [
      USER_LINE,
    ])
    try {
      const stream = await tailClaudeSessionFile(filePath, { pollMs: 10 })
      const iter = stream![Symbol.asyncIterator]()

      // Initial replay: one event.
      const first = await iter.next()
      expect(first.done).toBe(false)
      expect((first.value as { chunks: string[] }).chunks[0]).toContain(
        '"type":"user"',
      )

      // Append a new line; the next() should pick it up after the next poll.
      appendFileSync(filePath, ASSISTANT_LINE + '\n', 'utf8')
      const second = await iter.next()
      expect(second.done).toBe(false)
      expect((second.value as { chunks: string[] }).chunks[0]).toContain(
        '"type":"assistant"',
      )

      await iter.return!()
    } finally {
      cleanup()
    }
  })

  it('honors AbortSignal: next() resolves to done when the signal fires mid-poll', async () => {
    const { filePath, cleanup } = makeFakeSession('s3', '/workspace', [
      USER_LINE,
    ])
    try {
      const ac = new AbortController()
      const stream = await tailClaudeSessionFile(filePath, {
        pollMs: 10000, // long, so we'd hang without abort
        signal: ac.signal,
      })
      const iter = stream![Symbol.asyncIterator]()

      // Drain the initial line.
      const first = await iter.next()
      expect(first.done).toBe(false)

      // Now we're parked in sleep. Fire abort and assert next() returns done.
      const pendingNext = iter.next()
      setTimeout(() => ac.abort(), 20)
      const result = await pendingNext
      expect(result.done).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('skips malformed JSON lines without crashing the stream', async () => {
    const { filePath, cleanup } = makeFakeSession('s4', '/workspace', [
      'not even json',
      USER_LINE,
    ])
    try {
      const stream = await tailClaudeSessionFile(filePath, { pollMs: 10 })
      const iter = stream![Symbol.asyncIterator]()
      const r = await iter.next()
      expect(r.done).toBe(false)
      expect((r.value as { chunks: string[] }).chunks[0]).toContain(
        '"type":"user"',
      )
      await iter.return!()
    } finally {
      cleanup()
    }
  })
})

// ─── isClaudeSessionBusy ──────────────────────────────────────────────────
//
// These fixtures mirror the real on-disk shapes captured by killing live
// `claude -p` runs with various signals. Each terminal/in-flight state has
// its own test so a future change to claude's file format breaks the right
// test rather than a single conflated one.

const ATTACHMENT_LINE = JSON.stringify({
  type: 'attachment',
  attachment: { type: 'deferred_tools_delta', addedNames: [] },
})
const LAST_PROMPT_LINE = JSON.stringify({
  type: 'last-prompt',
  lastPrompt: 'fix the auth bug',
  sessionId: 'whatever',
})
const TURN_DURATION_LINE = JSON.stringify({
  type: 'system',
  subtype: 'turn_duration',
  durationMs: 1234,
})
const ASSISTANT_TOOL_USE_LINE = JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [], stop_reason: 'tool_use' },
})
const ASSISTANT_NULL_STOP_LINE = JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [], stop_reason: null },
})
const API_ERROR_ASSISTANT_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    model: '<synthetic>',
    content: [{ type: 'text', text: 'API Error: connection refused' }],
    stop_reason: 'stop_sequence',
  },
  isApiErrorMessage: true,
  error: 'unknown',
})
const INTERRUPTED_USER_LINE = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'text', text: '[Request interrupted by user]' }],
  },
})

describe('isClaudeSessionBusy', () => {
  it('returns false when the file does not exist', async () => {
    const { home, cleanup } = makeFakeSession('present', '/workspace', [])
    try {
      const missing = claudeSessionFilePath('absent', '/workspace', home)
      expect(await isClaudeSessionBusy(missing)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('returns false for an empty file', async () => {
    const { filePath, cleanup } = makeFakeSession('empty', '/workspace', [])
    try {
      expect(await isClaudeSessionBusy(filePath)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('clean exit (assistant end_turn → last-prompt) → idle', async () => {
    const { filePath, cleanup } = makeFakeSession('clean', '/workspace', [
      USER_LINE,
      ATTACHMENT_LINE,
      ASSISTANT_LINE, // stop_reason: end_turn
      LAST_PROMPT_LINE,
    ])
    try {
      expect(await isClaudeSessionBusy(filePath)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('interactive end-of-turn (turn_duration as last line) → idle', async () => {
    const { filePath, cleanup } = makeFakeSession('interactive', '/workspace', [
      USER_LINE,
      ASSISTANT_LINE,
      TURN_DURATION_LINE,
    ])
    try {
      expect(await isClaudeSessionBusy(filePath)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('SIGTERM (last-prompt without an assistant message) → idle', async () => {
    const { filePath, cleanup } = makeFakeSession('sigterm', '/workspace', [
      USER_LINE,
      ATTACHMENT_LINE,
      ATTACHMENT_LINE,
      LAST_PROMPT_LINE,
    ])
    try {
      expect(await isClaudeSessionBusy(filePath)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('SIGINT (last-prompt followed by [Request interrupted by user]) → idle', async () => {
    const { filePath, cleanup } = makeFakeSession('sigint', '/workspace', [
      USER_LINE,
      ATTACHMENT_LINE,
      LAST_PROMPT_LINE,
      INTERRUPTED_USER_LINE,
    ])
    try {
      expect(await isClaudeSessionBusy(filePath)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('API error (synthetic assistant stop_sequence + last-prompt) → idle', async () => {
    const { filePath, cleanup } = makeFakeSession('apierr', '/workspace', [
      USER_LINE,
      ATTACHMENT_LINE,
      API_ERROR_ASSISTANT_LINE,
      LAST_PROMPT_LINE,
    ])
    try {
      expect(await isClaudeSessionBusy(filePath)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('mid-turn (user + attachments, no assistant yet) → busy', async () => {
    const { filePath, cleanup } = makeFakeSession('midturn', '/workspace', [
      USER_LINE,
      ATTACHMENT_LINE,
      ATTACHMENT_LINE,
    ])
    try {
      expect(await isClaudeSessionBusy(filePath)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('SIGKILL (same shape as mid-turn) → reported busy (accepted gap)', async () => {
    // Identical on-disk state to mid-turn — kill -9 leaves no marker.
    // Documented as a known stuck state.
    const { filePath, cleanup } = makeFakeSession('sigkill', '/workspace', [
      USER_LINE,
      ATTACHMENT_LINE,
    ])
    try {
      expect(await isClaudeSessionBusy(filePath)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('mid-tool-execution (assistant stop_reason: tool_use) → busy', async () => {
    const { filePath, cleanup } = makeFakeSession('tooluse', '/workspace', [
      USER_LINE,
      ASSISTANT_TOOL_USE_LINE,
    ])
    try {
      expect(await isClaudeSessionBusy(filePath)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('partial assistant message (stop_reason: null) → busy', async () => {
    const { filePath, cleanup } = makeFakeSession('partial', '/workspace', [
      USER_LINE,
      ASSISTANT_NULL_STOP_LINE,
    ])
    try {
      expect(await isClaudeSessionBusy(filePath)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('multi-turn idle: prior turns completed, no new turn started → idle', async () => {
    const { filePath, cleanup } = makeFakeSession('multi-idle', '/workspace', [
      USER_LINE,
      ASSISTANT_LINE,
      LAST_PROMPT_LINE,
      USER_LINE,
      ASSISTANT_LINE,
      LAST_PROMPT_LINE,
    ])
    try {
      expect(await isClaudeSessionBusy(filePath)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('multi-turn busy: prior turns completed, new turn in flight → busy', async () => {
    const { filePath, cleanup } = makeFakeSession('multi-busy', '/workspace', [
      USER_LINE,
      ASSISTANT_LINE,
      LAST_PROMPT_LINE,
      USER_LINE, // new turn started, no assistant yet
      ATTACHMENT_LINE,
    ])
    try {
      expect(await isClaudeSessionBusy(filePath)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('skips trailing corrupted JSON line and uses the prior verdict-bearing line', async () => {
    const { filePath, cleanup } = makeFakeSession('corrupt-tail', '/workspace', [
      USER_LINE,
      ASSISTANT_LINE,
      LAST_PROMPT_LINE,
      'not-even-json-truncated-mid-write',
    ])
    try {
      expect(await isClaudeSessionBusy(filePath)).toBe(false)
    } finally {
      cleanup()
    }
  })
})

