import { describe, it, expect } from 'vitest'
import { resolveEnvPassthrough } from './env.js'
import type { AgentAdapter } from '@zooid/budd-core'

// Minimal AgentAdapter stub — only `name` and `envPassthrough` are read by
// resolveEnvPassthrough. Everything else is unused at this layer.
function adapter(envPassthrough?: string[]): AgentAdapter {
  return {
    name: 'stub',
    envPassthrough,
    isAvailable: () => true,
    prepareNewSession: () => ({ strategy: 'preassigned', session_id: 'x' }),
    spawn: () => ({ command: 'true', args: [] }),
  }
}

describe('resolveEnvPassthrough', () => {
  it('forwards adapter-declared env vars that exist in process.env', () => {
    const out = resolveEnvPassthrough(
      adapter(['ANTHROPIC_API_KEY']),
      undefined,
      { ANTHROPIC_API_KEY: 'sk-abc' },
    )
    expect(out).toEqual([['ANTHROPIC_API_KEY', 'sk-abc']])
  })

  it('silently drops adapter-declared env vars missing from process.env', () => {
    const out = resolveEnvPassthrough(
      adapter(['ANTHROPIC_API_KEY']),
      undefined,
      {},
    )
    expect(out).toEqual([])
  })

  it('merges user forward_env (pass-through) with adapter-declared list', () => {
    const out = resolveEnvPassthrough(
      adapter(['ANTHROPIC_API_KEY']),
      ['JIRA_URL'],
      { ANTHROPIC_API_KEY: 'sk-abc', JIRA_URL: 'https://j.example' },
    )
    expect(out).toEqual([
      ['ANTHROPIC_API_KEY', 'sk-abc'],
      ['JIRA_URL', 'https://j.example'],
    ])
  })

  it('handles rename entries (HOST:CONTAINER)', () => {
    const out = resolveEnvPassthrough(
      adapter(),
      ['CORP_JIRA_TOKEN:JIRA_TOKEN'],
      { CORP_JIRA_TOKEN: 'abc' },
    )
    expect(out).toEqual([['JIRA_TOKEN', 'abc']])
    // Original host name should NOT appear container-side.
    expect(out.find(([k]) => k === 'CORP_JIRA_TOKEN')).toBeUndefined()
  })

  it('drops rename entries whose source is undefined', () => {
    const out = resolveEnvPassthrough(
      adapter(),
      ['CORP_JIRA_TOKEN:JIRA_TOKEN'],
      {},
    )
    expect(out).toEqual([])
  })

  it('blocks BUDD_TOKEN even if explicitly listed in forward_env', () => {
    const out = resolveEnvPassthrough(
      adapter(),
      ['BUDD_TOKEN'],
      { BUDD_TOKEN: 'super-secret' },
    )
    expect(out).toEqual([])
  })

  it('blocks BUDD_* prefix even if explicitly listed in forward_env', () => {
    const out = resolveEnvPassthrough(
      adapter(),
      ['BUDD_INTERNAL'],
      { BUDD_INTERNAL: 'x' },
    )
    expect(out).toEqual([])
  })

  it('blocks rename when host side is BUDD_*', () => {
    const out = resolveEnvPassthrough(
      adapter(),
      ['BUDD_TOKEN:FOO'],
      { BUDD_TOKEN: 'x' },
    )
    expect(out).toEqual([])
  })

  it('blocks rename when container side is BUDD_*', () => {
    const out = resolveEnvPassthrough(
      adapter(),
      ['FOO:BUDD_X'],
      { FOO: 'x' },
    )
    expect(out).toEqual([])
  })

  it('dedups by container-side name; later wins', () => {
    const out = resolveEnvPassthrough(
      adapter(['FOO']),
      ['FOO:X', 'BAR:X'],
      { FOO: 'one', BAR: 'two' },
    )
    // Adapter declares FOO same-name; user declares two renames both targeting X.
    // After dedup-by-target: FOO entry stays, X entry is the last-wins (BAR=two).
    expect(out).toEqual([
      ['FOO', 'one'],
      ['X', 'two'],
    ])
  })

  it('returns entries sorted alphabetically by container-side name', () => {
    const out = resolveEnvPassthrough(
      adapter(['ZED']),
      ['ALPHA', 'MIKE'],
      { ZED: 'z', ALPHA: 'a', MIKE: 'm' },
    )
    expect(out.map(([k]) => k)).toEqual(['ALPHA', 'MIKE', 'ZED'])
  })

  it('adapter-declared list with no process.env value contributes nothing', () => {
    const out = resolveEnvPassthrough(
      adapter(['ANTHROPIC_API_KEY', 'CODEX_API_KEY']),
      undefined,
      { ANTHROPIC_API_KEY: 'sk-' },
    )
    expect(out).toEqual([['ANTHROPIC_API_KEY', 'sk-']])
  })
})
