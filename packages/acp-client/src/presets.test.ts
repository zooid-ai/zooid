import { describe, it, expect } from 'vitest'
import { PRESETS, resolvePreset, isPreset } from './presets.js'

describe('PRESETS registry', () => {
  it('includes the ACP-native harnesses from SPEC.md', () => {
    expect(PRESETS.opencode).toEqual({ command: 'opencode', args: ['acp'] })
    expect(PRESETS.cline).toEqual({ command: 'cline', args: ['--acp'] })
    expect(PRESETS.kiro).toEqual({ command: 'kiro', args: ['--acp'] })
    expect(PRESETS.gemini).toEqual({ command: 'gemini', args: ['--acp'] })
  })

  it('includes the vendored-shim harnesses', () => {
    expect(PRESETS.claude).toEqual({
      command: 'npx',
      args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    })
    expect(PRESETS.codex).toEqual({
      command: 'npx',
      args: ['-y', '@zed-industries/codex-acp'],
    })
  })
})

describe('resolvePreset', () => {
  it('returns the command/args tuple for a known preset', () => {
    expect(resolvePreset('claude')).toEqual({
      command: 'npx',
      args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    })
  })

  it('throws a clear error for an unknown preset', () => {
    expect(() => resolvePreset('made-up')).toThrow(/unknown ACP preset/i)
  })

  it('error message lists the available presets', () => {
    try {
      resolvePreset('made-up')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('claude')
      expect(msg).toContain('opencode')
    }
  })

  it('returns a fresh args array each call (no shared mutable state)', () => {
    const a = resolvePreset('claude')
    const b = resolvePreset('claude')
    expect(a).not.toBe(b)
    expect(a.args).not.toBe(b.args)
    a.args.push('mutated')
    expect(b.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp'])
  })

  it('appends --model <id> to claude when opts.model is set', () => {
    const spec = resolvePreset('claude', { model: 'claude-sonnet-4-6' })
    expect(spec.args).toEqual([
      '-y',
      '@agentclientprotocol/claude-agent-acp',
      '--model',
      'claude-sonnet-4-6',
    ])
  })

  it('passes model to codex via `-c model="..."` (codex-acp uses TOML config overrides)', () => {
    const spec = resolvePreset('codex', { model: 'gpt-5.5' })
    expect(spec.args).toEqual([
      '-y',
      '@zed-industries/codex-acp',
      '-c',
      'model="gpt-5.5"',
    ])
  })

  it('ignores opts.model for opencode (model lives in opencode.json)', () => {
    const spec = resolvePreset('opencode', { model: 'opencode-go/kimi-k2.6' })
    expect(spec.args).toEqual(['acp'])
  })

  it('returns the bare preset spec when no opts are given', () => {
    const spec = resolvePreset('claude')
    expect(spec.command).toBe('npx')
    expect(spec.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp'])
  })
})

describe('isPreset', () => {
  it('returns true for known names', () => {
    expect(isPreset('claude')).toBe(true)
    expect(isPreset('opencode')).toBe(true)
  })
  it('returns false for unknown names', () => {
    expect(isPreset('made-up')).toBe(false)
  })
  it('narrows the type so the value can index PRESETS', () => {
    const name: string = 'claude'
    if (isPreset(name)) {
      const _entry = PRESETS[name]
      expect(_entry.command).toBe('npx')
    }
  })
})
