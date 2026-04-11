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
    ])
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

describe('claudeAdapter.parseOutput', () => {
  it('parses a JSON line into kind/content', () => {
    const result = claudeAdapter.parseOutput!(
      '{"type":"assistant","content":"hi"}',
    )
    expect(result.kind).toBe('assistant')
    expect((result.content as { content: string }).content).toBe('hi')
  })

  it('falls back to raw for non-JSON lines', () => {
    const result = claudeAdapter.parseOutput!('not json')
    expect(result.kind).toBe('raw')
    expect(result.content).toBe('not json')
  })
})
