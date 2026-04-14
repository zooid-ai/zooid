import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { codexAdapter } from './codex.js'

const FIXTURES_BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/bin',
)

describe('codexAdapter.spawn', () => {
  it('builds a new-session invocation with codex exec --json', () => {
    const config = codexAdapter.spawn({
      prompt: 'fix the auth bug',
      session_id: undefined,
      resume: false,
    })
    expect(config.command).toBe('codex')
    expect(config.args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      'fix the auth bug',
    ])
  })

  it('builds a resume invocation with codex exec resume', () => {
    const config = codexAdapter.spawn({
      prompt: 'also add tests',
      session_id: 'abc-123-uuid',
      resume: true,
    })
    expect(config.args).toEqual([
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      'abc-123-uuid',
      'also add tests',
    ])
  })

  it('throws if session_id is missing on resume', () => {
    expect(() =>
      codexAdapter.spawn({
        prompt: 'x',
        session_id: undefined,
        resume: true,
      }),
    ).toThrow(/session_id is required/)
  })

  it('allows undefined session_id on new session (deferred strategy)', () => {
    expect(() =>
      codexAdapter.spawn({
        prompt: 'hello',
        session_id: undefined,
        resume: false,
      }),
    ).not.toThrow()
  })
})

describe('codexAdapter.prepareNewSession', () => {
  it('returns deferred strategy — Codex picks its own session id', () => {
    const plan = codexAdapter.prepareNewSession()
    expect(plan.strategy).toBe('deferred')
  })
})

describe('codexAdapter.parseOutput', () => {
  it('extracts session_id from thread.started', () => {
    const result = codexAdapter.parseOutput!(
      '{"type":"thread.started","thread_id":"abc-123"}',
    )
    expect(result).toEqual({
      kind: 'session_started',
      session_id: 'abc-123',
    })
  })

  it('extracts message from item.completed', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'hello' },
    })
    const result = codexAdapter.parseOutput!(line)
    expect(result.kind).toBe('message')
  })

  it('ignores turn.started', () => {
    const result = codexAdapter.parseOutput!('{"type":"turn.started"}')
    expect(result).toEqual({ kind: 'ignore' })
  })

  it('ignores turn.completed', () => {
    const result = codexAdapter.parseOutput!(
      '{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}',
    )
    expect(result).toEqual({ kind: 'ignore' })
  })

  it('ignores malformed JSON', () => {
    const result = codexAdapter.parseOutput!('not json at all')
    expect(result).toEqual({ kind: 'ignore' })
  })
})

describe('codexAdapter.isAvailable', () => {
  it('returns true when codex is on PATH', () => {
    expect(codexAdapter.isAvailable(FIXTURES_BIN)).toBe(true)
  })

  it('returns false when codex is not on PATH', () => {
    expect(codexAdapter.isAvailable('/nonexistent')).toBe(false)
  })
})

describe('codexAdapter mount defaults', () => {
  it('declares workspaceReadOnly for AGENTS.md and .codex', () => {
    expect(codexAdapter.workspaceReadOnly).toEqual(['AGENTS.md', '.codex'])
  })
  it('declares homeReadOnly for .codex/config.toml', () => {
    expect(codexAdapter.homeReadOnly).toEqual(['.codex/config.toml'])
  })
  it('sessionStateDir is .codex/sessions', () => {
    expect(codexAdapter.sessionStateDir?.('/workspace')).toBe('.codex/sessions')
  })
})
