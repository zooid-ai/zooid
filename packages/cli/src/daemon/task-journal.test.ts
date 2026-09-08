import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTaskJournal } from './task-journal.js'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const makeDir = () => { const dir = mkdtempSync(join(tmpdir(), 'zooid-task-')); dirs.push(dir); return dir }
const row = { taskId: 't', attemptId: 't', roomId: '!r', assignee: 'a', notify: 'caller' as const, parent: { agent: 'p', threadRoot: '$p', sessionKey: '$p', generation: 0 }, phase: 'open' as const, threadRoot: '$r', runId: 'run' }
describe('makeTaskJournal', () => {
  it('round-trips data and tolerates corruption', () => {
    const dir = makeDir(); const journal = makeTaskJournal(dir)
    expect(journal.load()).toEqual([])
    journal.save([row]); expect(journal.load()).toEqual([row])
    writeFileSync(join(dir, 'tasks.json'), '{broken')
    expect(journal.load()).toEqual([])
  })
})
