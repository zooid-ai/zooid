import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sniffCredentials } from './sniff.js'

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
