import { mkdir, readdir, rm, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export interface LogPaths {
  dataDir: string
  logsDir: string
  dayDir: string
  daySlug: string
  todayLink: string
  tuwunelLog: string
  daemonLog: string
  devLog: string
  agentLog: (agentName: string) => string
  agentTap: (agentName: string) => string
}

export interface ResolveOpts {
  dataDir: string
  /** Defaults to `new Date()`. Tests pin this for determinism. */
  now?: Date
}

// Local-time slug — we want the wall-clock day a session started, not UTC.
function localDateSlug(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export function resolveLogPaths({ dataDir, now }: ResolveOpts): LogPaths {
  const slug = localDateSlug(now ?? new Date())
  const logsDir = join(dataDir, 'logs')
  const dayDir = join(logsDir, slug)
  return {
    dataDir,
    logsDir,
    dayDir,
    daySlug: slug,
    todayLink: join(logsDir, 'today'),
    tuwunelLog: join(dayDir, 'tuwunel.log'),
    daemonLog: join(dayDir, 'daemon.log'),
    devLog: join(dayDir, 'dev.log'),
    agentLog: (n) => join(dayDir, `agent-${n}.log`),
    agentTap: (n) => join(dayDir, `agent-${n}.acp.jsonl`),
  }
}

export async function ensureDayFolder(p: LogPaths): Promise<void> {
  await mkdir(p.dayDir, { recursive: true })
  // Symlink target is the relative slug so the link survives a moved data dir.
  try {
    await unlink(p.todayLink)
  } catch {
    // may not exist
  }
  await symlink(p.daySlug, p.todayLink)
}

export interface PruneOpts {
  dataDir: string
  now?: Date
  retainDays: number
}

export async function pruneOldDays(opts: PruneOpts): Promise<string[]> {
  if (opts.retainDays <= 0) return []
  const logsDir = join(opts.dataDir, 'logs')
  let entries: string[]
  try {
    entries = await readdir(logsDir)
  } catch {
    return []
  }
  const today = opts.now ?? new Date()
  const cutoff = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - opts.retainDays + 1,
  ).getTime()
  const removed: string[] = []
  for (const name of entries) {
    if (!DAY_RE.test(name)) continue
    const [y, m, d] = name.split('-').map(Number)
    const t = new Date(y, m - 1, d).getTime()
    if (t < cutoff) {
      await rm(join(logsDir, name), { recursive: true, force: true })
      removed.push(name)
    }
  }
  return removed
}
