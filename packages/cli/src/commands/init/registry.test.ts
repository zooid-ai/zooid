import { describe, it, expect } from 'vitest'
import {
  SIMPLE_PRESETS,
  OPENCODE_PROVIDERS,
  findSimplePreset,
  findOpencodeProvider,
  PI_PROVIDERS,
  PI_DEFAULT_PROVIDER,
  PI_DEFAULT_MODEL,
  PI_AGENT_DIR,
  PI_AUTH_FILE,
  PI_SETTINGS_FILE,
  PI_AUTH_MODES,
  findPiProvider,
} from './registry.js'

describe('init registry', () => {
  it('SIMPLE_PRESETS contains claude and codex (no model lists to maintain)', () => {
    const names = SIMPLE_PRESETS.map((p) => p.preset)
    expect(names).toEqual(['claude', 'codex'])
    for (const p of SIMPLE_PRESETS) {
      expect(p).not.toHaveProperty('models')
      expect(p.apiKeyEnvVar).toMatch(/^[A-Z_]+_API_KEY$/)
      expect(p.credentialDir.length).toBeGreaterThan(0)
    }
  })

  it('OPENCODE_PROVIDERS lists opencode-go first as the recommended default', () => {
    expect(OPENCODE_PROVIDERS[0]?.id).toBe('opencode-go')
  })

  it('findSimplePreset returns the entry by name', () => {
    expect(findSimplePreset('claude')?.preset).toBe('claude')
    expect(findSimplePreset('nope')).toBeUndefined()
  })

  it('findOpencodeProvider returns the entry by id', () => {
    expect(findOpencodeProvider('opencode-go')?.id).toBe('opencode-go')
    expect(findOpencodeProvider('nope')).toBeUndefined()
  })
})

describe('pi registry (ZOD075)', () => {
  it('PI_PROVIDERS leads with openrouter, the verified default', () => {
    expect(PI_PROVIDERS[0]?.id).toBe('openrouter')
  })

  it('every provider carries an API-key env var', () => {
    for (const p of PI_PROVIDERS) {
      expect(p.apiKeyEnvVar).toMatch(/^[A-Z_]+_API_KEY$/)
      expect(p.label.length).toBeGreaterThan(0)
    }
  })

  // anthropic stays reachable, but must not be the default: pi bills Claude
  // Pro/Max through "extra usage", which starts at zero, so a claude default
  // 400s for exactly the operator most likely to try Zooid.
  it('includes anthropic as a choice but not as the default', () => {
    expect(PI_PROVIDERS.map((p) => p.id)).toContain('anthropic')
    expect(PI_DEFAULT_PROVIDER).not.toBe('anthropic')
  })

  it('pins the verified fallback provider and model', () => {
    expect(PI_DEFAULT_PROVIDER).toBe('openrouter')
    expect(PI_DEFAULT_MODEL).toBe('deepseek/deepseek-v4-pro')
  })

  it('findPiProvider returns the entry by id', () => {
    expect(findPiProvider('openrouter')?.id).toBe('openrouter')
    expect(findPiProvider('nope')).toBeUndefined()
  })

  // pi DOES share the subscription-or-key binary (that is what PI_AUTH_MODES
  // encodes). It stays out of SIMPLE_PRESETS for the other reason: those rows
  // carry ONE apiKeyEnvVar and ONE credentialDir, and pi needs a provider table.
  it('pi is NOT in SIMPLE_PRESETS — those rows cannot hold a provider table', () => {
    expect(SIMPLE_PRESETS.map((p) => p.preset)).not.toContain('pi')
  })

  it('exposes the agent dir and the home-relative pi paths', () => {
    expect(PI_AGENT_DIR).toBe('.pi-agent')
    expect(PI_AUTH_FILE).toBe('.pi/agent/auth.json')
    expect(PI_SETTINGS_FILE).toBe('.pi/agent/settings.json')
  })
})

describe('pi auth binary (ZOD075)', () => {
  // pi's auth surface is the UNION of the two existing shapes: opencode's
  // provider table plus claude/codex's subscription-or-api-key binary.
  it('accepts the same two auth values as claude/codex', () => {
    expect(PI_AUTH_MODES).toEqual(['subscription', 'api-key'])
  })
})
