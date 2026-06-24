import { describe, it, expect } from 'vitest'
import {
  SIMPLE_PRESETS,
  OPENCODE_PROVIDERS,
  findSimplePreset,
  findOpencodeProvider,
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
