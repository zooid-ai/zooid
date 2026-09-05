import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sniffCredentials, sniffPiDefaults } from './sniff.js'

let fakeHome: string

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'zooid-sniff-'))
})

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true })
})

describe('sniffCredentials', () => {
  it('reports found when ~/.claude/ exists', () => {
    mkdirSync(join(fakeHome, '.claude'))
    const r = sniffCredentials('claude', fakeHome)
    expect(r.found).toBe(true)
    expect(r.path).toMatch(/\.claude$/)
  })

  it('reports found when ~/.codex/ exists', () => {
    mkdirSync(join(fakeHome, '.codex'))
    const r = sniffCredentials('codex', fakeHome)
    expect(r.found).toBe(true)
    expect(r.path).toMatch(/\.codex$/)
  })

  it('reports not-found when no config dir exists', () => {
    const r = sniffCredentials('claude', fakeHome)
    expect(r.found).toBe(false)
  })

  it('does not read directory contents — empty dir still counts as found', () => {
    mkdirSync(join(fakeHome, '.claude'))
    expect(sniffCredentials('claude', fakeHome).found).toBe(true)
  })
})

describe('sniffCredentials — pi (ZOD075)', () => {
  // pi's credential is a FILE, not a directory like ~/.claude — existsSync
  // covers both, but the path must point at auth.json.
  it('reports found when ~/.pi/agent/auth.json exists', () => {
    mkdirSync(join(fakeHome, '.pi', 'agent'), { recursive: true })
    writeFileSync(join(fakeHome, '.pi', 'agent', 'auth.json'), '{}')
    const r = sniffCredentials('pi', fakeHome)
    expect(r.found).toBe(true)
    expect(r.path).toMatch(/auth\.json$/)
  })

  it('reports not-found when ~/.pi is absent', () => {
    expect(sniffCredentials('pi', fakeHome).found).toBe(false)
  })

  it('reports not-found when ~/.pi/agent exists but holds no auth.json', () => {
    mkdirSync(join(fakeHome, '.pi', 'agent'), { recursive: true })
    expect(sniffCredentials('pi', fakeHome).found).toBe(false)
  })
})

describe('sniffPiDefaults (ZOD075)', () => {
  const write = (obj: unknown) => {
    mkdirSync(join(fakeHome, '.pi', 'agent'), { recursive: true })
    writeFileSync(join(fakeHome, '.pi', 'agent', 'settings.json'), JSON.stringify(obj))
  }

  // Inheriting a pair the operator already runs interactively beats any default
  // this repo could guess — it is verified by use.
  it('inherits defaultProvider and defaultModel from the global settings', () => {
    write({ theme: 'dark', defaultProvider: 'openrouter', defaultModel: 'deepseek/deepseek-v4-flash' })
    expect(sniffPiDefaults(fakeHome)).toEqual({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
      source: join(fakeHome, '.pi', 'agent', 'settings.json'),
    })
  })

  it('returns undefined when no settings file exists', () => {
    expect(sniffPiDefaults(fakeHome)).toBeUndefined()
  })

  // A settings file that pins neither is the common case for a casual pi user;
  // half a pair is not inheritable either.
  it('returns undefined when the pair is absent or incomplete', () => {
    write({ theme: 'dark' })
    expect(sniffPiDefaults(fakeHome)).toBeUndefined()
    write({ defaultProvider: 'openrouter' })
    expect(sniffPiDefaults(fakeHome)).toBeUndefined()
  })

  // Never let a corrupt personal config abort someone's onboarding.
  it('returns undefined rather than throwing on malformed JSON', () => {
    mkdirSync(join(fakeHome, '.pi', 'agent'), { recursive: true })
    writeFileSync(join(fakeHome, '.pi', 'agent', 'settings.json'), '{not json')
    expect(sniffPiDefaults(fakeHome)).toBeUndefined()
  })
})
