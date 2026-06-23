import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeSyncCursorStore } from './sync-cursors.js'

let agentsDir: string
beforeEach(() => {
  agentsDir = mkdtempSync(join(tmpdir(), 'zooid-agents-'))
})
afterEach(() => rmSync(agentsDir, { recursive: true, force: true }))

describe('makeSyncCursorStore', () => {
  it('returns null before any save (cold start)', () => {
    const store = makeSyncCursorStore(agentsDir)
    expect(store.loadSince('docs')).toBeNull()
  })

  it('round-trips a since cursor per agent name', () => {
    const store = makeSyncCursorStore(agentsDir)
    store.saveSince('docs', 's42')
    store.saveSince('triage', 's7')
    expect(store.loadSince('docs')).toBe('s42')
    expect(store.loadSince('triage')).toBe('s7')
  })

  it('persists across store instances (simulates daemon restart)', () => {
    makeSyncCursorStore(agentsDir).saveSince('docs', 's99')
    expect(makeSyncCursorStore(agentsDir).loadSince('docs')).toBe('s99')
  })

  it('writes sync-since beside sessions.json under <agentsDir>/<agentName>/', () => {
    makeSyncCursorStore(agentsDir).saveSince('docs', 's1')
    const path = join(agentsDir, 'docs', 'sync-since')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('s1')
  })
})
