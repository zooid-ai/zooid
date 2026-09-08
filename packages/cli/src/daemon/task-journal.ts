import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PersistedTask, TaskJournal } from '@zooid/transport-matrix'

interface JournalFile { version: 1; tasks: PersistedTask[] }

/** Durable, small task-state journal stored alongside daemon state. */
export function makeTaskJournal(dataDir: string): TaskJournal {
  const path = join(dataDir, 'tasks.json')
  return {
    load() {
      try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as JournalFile
        return value.version === 1 && Array.isArray(value.tasks) ? value.tasks : []
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[tasks] journal unavailable; starting empty:', error)
        return []
      }
    },
    save(tasks) {
      mkdirSync(dataDir, { recursive: true })
      const temp = `${path}.tmp-${process.pid}`
      try {
        writeFileSync(temp, JSON.stringify({ version: 1, tasks } satisfies JournalFile, null, 2), 'utf8')
        renameSync(temp, path)
      } catch (error) {
        console.warn('[tasks] journal write failed:', error)
        try { unlinkSync(temp) } catch {}
      }
    },
  }
}
