import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SessionStoreOptions {
  /** Stable agent id; written into the file as a sanity-check on load. */
  agentId: string
  /** Directory holding `sessions.json`. Typically `<dataRoot>/agents/<agentId>/`. */
  dir: string
}

interface StoredFile {
  version: 1
  agent_id: string
  sessions: Array<{
    thread_id: string
    session_id: string
    updated_at: string
  }>
}

/**
 * Per-agent JSON-file-backed map of `threadId → sessionId`. In-memory map is
 * the source of truth at runtime; writes are flushed atomically (write to a
 * temp file then rename) and serialised so concurrent set/delete calls never
 * produce a partial file.
 *
 * Scale ceiling: every set rewrites the whole file. ZOD042 will swap this
 * impl for a SQLite-backed one with the same surface beyond ~10k threads.
 */
export class JsonFileSessionStore {
  private readonly mem = new Map<string, string>()
  private readonly path: string
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly opts: SessionStoreOptions) {
    this.path = join(opts.dir, 'sessions.json')
  }

  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      console.warn(`[acp-client:${this.opts.agentId}] sessions.json read failed:`, err)
      return
    }
    let parsed: StoredFile
    try {
      parsed = JSON.parse(raw) as StoredFile
    } catch (err) {
      console.warn(`[acp-client:${this.opts.agentId}] sessions.json corrupt; treating as empty:`, err)
      return
    }
    if (parsed.version !== 1) {
      console.warn(
        `[acp-client:${this.opts.agentId}] sessions.json version=${parsed.version} unknown; treating as empty`,
      )
      return
    }
    if (parsed.agent_id !== this.opts.agentId) {
      console.warn(
        `[acp-client:${this.opts.agentId}] sessions.json agent_id mismatch ` +
          `(file=${parsed.agent_id}); treating as empty`,
      )
      return
    }
    for (const row of parsed.sessions ?? []) {
      if (typeof row.thread_id === 'string' && typeof row.session_id === 'string') {
        this.mem.set(row.thread_id, row.session_id)
      }
    }
  }

  get(threadId: string): string | undefined {
    return this.mem.get(threadId)
  }

  async set(threadId: string, sessionId: string): Promise<void> {
    this.mem.set(threadId, sessionId)
    await this.flush()
  }

  async delete(threadId: string): Promise<void> {
    if (!this.mem.has(threadId)) return
    this.mem.delete(threadId)
    await this.flush()
  }

  async flush(): Promise<void> {
    const next = (this.writeChain = this.writeChain.then(() => this.writeNow()))
    return next
  }

  private async writeNow(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true })
    const file: StoredFile = {
      version: 1,
      agent_id: this.opts.agentId,
      sessions: Array.from(this.mem.entries()).map(([thread_id, session_id]) => ({
        thread_id,
        session_id,
        updated_at: new Date().toISOString(),
      })),
    }
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, JSON.stringify(file, null, 2), 'utf8')
    await rename(tmp, this.path)
  }
}
