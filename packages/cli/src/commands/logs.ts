import { readFile, readdir, readlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pruneOldDays } from '../observability/paths.js'

export interface LogsFlags {
  dataDir: string
  source?: string
  day?: string
  turn?: string
  follow?: boolean
  subcommand?: 'prune'
  keep?: number
  /** Tests inject an alternate writer. */
  writer?: (s: string) => void
  now?: Date
}

const KNOWN_SOURCES = ['tuwunel', 'daemon', 'dev'] as const

export async function runLogs(flags: LogsFlags): Promise<void> {
  const writer = flags.writer ?? ((s: string) => process.stdout.write(s))

  if (flags.subcommand === 'prune') {
    const removed = await pruneOldDays({
      dataDir: flags.dataDir,
      retainDays: flags.keep ?? 14,
      now: flags.now,
    })
    writer(`pruned ${removed.length} day(s): ${removed.join(', ')}\n`)
    return
  }

  const day = flags.day ?? (await resolveTodaySlug(flags.dataDir))
  if (!day) {
    writer('no logs yet\n')
    return
  }
  const dayDir = join(flags.dataDir, 'logs', day)
  if (!existsSync(dayDir)) {
    writer(`no logs for ${day}\n`)
    return
  }

  if (flags.turn) {
    await dumpByTurn(dayDir, flags.turn, writer)
    return
  }

  if (!flags.source) {
    const entries = await readdir(dayDir)
    const sources = new Set<string>()
    for (const e of entries) {
      if (e.endsWith('.log')) sources.add(e.replace(/\.log$/, ''))
      if (e.endsWith('.acp.jsonl')) sources.add(e.replace(/\.acp\.jsonl$/, '.acp'))
    }
    writer([...sources].sort().join('\n') + '\n')
    return
  }

  const path = resolveSourcePath(dayDir, flags.source)
  if (!existsSync(path)) {
    writer(`no such source: ${flags.source}\n`)
    return
  }
  writer(await readFile(path, 'utf8'))
  // -f is intentionally not implemented in this cycle; documented as a follow-up.
}

async function resolveTodaySlug(dataDir: string): Promise<string | null> {
  const link = join(dataDir, 'logs', 'today')
  try {
    return await readlink(link)
  } catch {
    return null
  }
}

function resolveSourcePath(dayDir: string, source: string): string {
  if (source.startsWith('agent-')) {
    if (source.endsWith('.acp')) return join(dayDir, `${source.slice(0, -4)}.acp.jsonl`)
    return join(dayDir, `${source}.log`)
  }
  if ((KNOWN_SOURCES as readonly string[]).includes(source))
    return join(dayDir, `${source}.log`)
  return join(dayDir, source)
}

async function dumpByTurn(
  dayDir: string,
  turnId: string,
  writer: (s: string) => void,
): Promise<void> {
  const entries = await readdir(dayDir)
  const taps = entries.filter((e) => e.endsWith('.acp.jsonl')).sort()
  for (const f of taps) {
    const text = await readFile(join(dayDir, f), 'utf8')
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        if (obj.turn_id === turnId) writer(line + '\n')
      } catch {
        // skip malformed line
      }
    }
  }
}
