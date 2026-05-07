import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readlink, readdir, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { resolveLogPaths, ensureDayFolder, pruneOldDays } from './paths.js'

describe('observability paths', () => {
  let dataDir: string
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'zooid-obs-paths-'))
  })
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('places each source under logs/YYYY-MM-DD/', () => {
    const p = resolveLogPaths({ dataDir, now: new Date('2026-05-06T10:00:00Z') })
    expect(p.dayDir).toBe(join(dataDir, 'logs', '2026-05-06'))
    expect(p.tuwunelLog).toBe(join(p.dayDir, 'tuwunel.log'))
    expect(p.daemonLog).toBe(join(p.dayDir, 'daemon.log'))
    expect(p.devLog).toBe(join(p.dayDir, 'dev.log'))
    expect(p.agentLog('docs')).toBe(join(p.dayDir, 'agent-docs.log'))
    expect(p.agentTap('docs')).toBe(join(p.dayDir, 'agent-docs.acp.jsonl'))
    expect(p.todayLink).toBe(join(dataDir, 'logs', 'today'))
  })

  it('uses local-time date, not UTC', () => {
    // 2026-05-06 23:30 UTC is 2026-05-07 in many timezones; we want the
    // day the user *started* the session by their wall clock.
    const local = new Date(2026, 4, 6, 23, 30) // month is 0-indexed: May = 4
    const p = resolveLogPaths({ dataDir, now: local })
    expect(p.dayDir).toBe(join(dataDir, 'logs', '2026-05-06'))
  })

  it('ensureDayFolder creates the dir and points today→ at it', async () => {
    const p = resolveLogPaths({ dataDir, now: new Date('2026-05-06T10:00:00Z') })
    await ensureDayFolder(p)
    const linkTarget = await readlink(p.todayLink)
    expect(linkTarget).toBe('2026-05-06')
    const s = await stat(p.dayDir)
    expect(s.isDirectory()).toBe(true)
  })

  it('ensureDayFolder repoints today→ when the day rolls over', async () => {
    const day1 = resolveLogPaths({ dataDir, now: new Date('2026-05-06T10:00:00Z') })
    await ensureDayFolder(day1)
    const day2 = resolveLogPaths({ dataDir, now: new Date('2026-05-07T10:00:00Z') })
    await ensureDayFolder(day2)
    expect(await readlink(day2.todayLink)).toBe('2026-05-07')
  })

  it('pruneOldDays removes folders older than retainDays', async () => {
    const logs = join(dataDir, 'logs')
    for (const d of ['2026-04-20', '2026-05-01', '2026-05-05', '2026-05-06']) {
      await mkdir(join(logs, d), { recursive: true })
      await writeFile(join(logs, d, 'tuwunel.log'), 'x')
    }
    const removed = await pruneOldDays({
      dataDir,
      now: new Date('2026-05-06T10:00:00Z'),
      retainDays: 3,
    })
    expect(removed.sort()).toEqual(['2026-04-20', '2026-05-01'])
    const remaining = (await readdir(logs)).sort()
    expect(remaining).toEqual(['2026-05-05', '2026-05-06'])
  })

  it('pruneOldDays with retainDays=0 is a no-op', async () => {
    const logs = join(dataDir, 'logs')
    await mkdir(join(logs, '2024-01-01'), { recursive: true })
    const removed = await pruneOldDays({
      dataDir,
      now: new Date('2026-05-06T10:00:00Z'),
      retainDays: 0,
    })
    expect(removed).toEqual([])
  })

  it('pruneOldDays ignores non-date entries (the today symlink, junk)', async () => {
    const logs = join(dataDir, 'logs')
    await mkdir(join(logs, '2026-05-06'), { recursive: true })
    await mkdir(join(logs, 'not-a-date'), { recursive: true })
    const p = resolveLogPaths({ dataDir, now: new Date('2026-05-06T10:00:00Z') })
    await ensureDayFolder(p)
    const removed = await pruneOldDays({
      dataDir,
      now: new Date('2026-05-06T10:00:00Z'),
      retainDays: 1,
    })
    expect(removed).toEqual([])
  })

  it('treats its dataDir argument as the data root: logs become a top-level sibling', () => {
    // Pre-ZOD041 we passed the matrix dir, so logs landed at <matrix>/logs/.
    // Post-ZOD041 we pass the root, so logs land at <root>/logs/ (matrix is its sibling).
    const root = '/abs/data'
    const p = resolveLogPaths({ dataDir: root, now: new Date('2026-05-06T10:00:00Z') })
    expect(p.logsDir).toBe('/abs/data/logs')
    expect(p.dayDir).toBe('/abs/data/logs/2026-05-06')
    // Sanity: NOT under matrix.
    expect(p.logsDir.startsWith('/abs/data/matrix')).toBe(false)
  })
})
