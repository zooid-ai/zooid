import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { claudeAdapter } from './claude.js'

const FIXTURES_BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/bin',
)

describe('claudeAdapter.spawn', () => {
  it('builds a start invocation with --session-id', () => {
    const config = claudeAdapter.spawn({
      prompt: 'fix the auth bug',
      session_id: '01JQXYZ',
      resume: false,
    })
    expect(config.command).toBe('claude')
    expect(config.args).toEqual([
      '-p',
      'fix the auth bug',
      '--session-id',
      '01JQXYZ',
      '--output-format',
      'stream-json',
      '--verbose',
    ])
  })

  it('builds a resume invocation with --resume', () => {
    const config = claudeAdapter.spawn({
      prompt: 'also add tests',
      session_id: '01JQXYZ',
      resume: true,
    })
    expect(config.args).toEqual([
      '-p',
      'also add tests',
      '--resume',
      '01JQXYZ',
      '--output-format',
      'stream-json',
      '--verbose',
    ])
  })

  it('throws if session_id is missing (claude is preassigned-only)', () => {
    expect(() =>
      claudeAdapter.spawn({
        prompt: 'x',
        session_id: undefined,
        resume: false,
      }),
    ).toThrow(/session_id is required/)
  })
})

describe('claudeAdapter.prepareNewSession', () => {
  it('returns a preassigned UUID — Claude Code requires UUIDs for --session-id', () => {
    const plan = claudeAdapter.prepareNewSession()
    expect(plan.strategy).toBe('preassigned')
    if (plan.strategy !== 'preassigned') return
    expect(plan.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })

  it('returns a different id each call', () => {
    const a = claudeAdapter.prepareNewSession()
    const b = claudeAdapter.prepareNewSession()
    if (a.strategy !== 'preassigned' || b.strategy !== 'preassigned') {
      throw new Error('expected preassigned')
    }
    expect(a.session_id).not.toBe(b.session_id)
  })
})

describe('claudeAdapter.isAvailable', () => {
  it('returns true when claude is on PATH', () => {
    expect(claudeAdapter.isAvailable(FIXTURES_BIN)).toBe(true)
  })

  it('returns false when claude is not on PATH', () => {
    expect(claudeAdapter.isAvailable('/nonexistent')).toBe(false)
  })
})

describe('claudeAdapter mount defaults', () => {
  it('declares workspaceReadOnly for CLAUDE.md and .claude', () => {
    expect(claudeAdapter.workspaceReadOnly).toEqual(['CLAUDE.md', '.claude'])
  })
  it('declares homeReadOnly for .claude/settings.json', () => {
    expect(claudeAdapter.homeReadOnly).toEqual(['.claude/settings.json'])
  })
  it('sessionStateDir encodes the container workdir path', () => {
    expect(claudeAdapter.sessionStateDir?.('/workspace')).toBe(
      '.claude/projects/-workspace',
    )
    expect(claudeAdapter.sessionStateDir?.('/workspace/sub')).toBe(
      '.claude/projects/-workspace-sub',
    )
  })
})

describe('claudeAdapter — envPassthrough', () => {
  it('declares ANTHROPIC_API_KEY', () => {
    expect(claudeAdapter.envPassthrough).toEqual(['ANTHROPIC_API_KEY'])
  })
})
