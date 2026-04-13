import { existsSync } from 'node:fs'
import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@zooid/budd-core'

/**
 * Find the on-disk JSONL session file for a given Codex session id.
 *
 * Codex stores sessions in a date-partitioned tree:
 *
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-timestamp>-<UUID>.jsonl
 *
 * The UUID is embedded in the filename. Unlike Claude Code, the path is NOT
 * scoped by cwd — it's global under `~/.codex/sessions/`. So we glob across
 * all date dirs looking for a filename that ends with `<id>.jsonl`.
 *
 * Returns the file path or `null` if not found.
 */
export async function findCodexSessionFile(
  id: string,
  homeDir: string = homedir(),
): Promise<string | null> {
  const sessionsDir = join(homeDir, '.codex', 'sessions')
  if (!existsSync(sessionsDir)) return null
  return walkForId(sessionsDir, id)
}

async function walkForId(dir: string, id: string): Promise<string | null> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = await walkForId(full, id)
      if (found) return found
    } else if (entry.isFile() && entry.name.endsWith(`${id}.jsonl`)) {
      return full
    }
  }
  return null
}

/**
 * Map one JSONL line from Codex's on-disk session file to a `SessionEvent`,
 * or `null` if the line should be skipped.
 *
 * Codex's on-disk format differs from its stdout JSONL. On-disk lines have
 * a `timestamp` field and use `event_msg` / `response_item` / `session_meta`
 * envelopes. We forward meaningful lines verbatim as `stdout` chunks so
 * consumers can parse the full structure themselves — same approach as the
 * claude adapter.
 *
 * Filtered noise: `token_count` and `turn_context` event_msg types are
 * bookkeeping and not part of the conversation.
 */
export function lineToEvent(line: string): SessionEvent | null {
  if (line.length === 0) return null
  let parsed: { type?: string; payload?: { type?: string } }
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  // Filter noise events
  if (parsed.type === 'event_msg') {
    const pt = parsed.payload?.type
    if (pt === 'token_count' || pt === 'turn_context') return null
  }
  return { type: 'stdout', chunks: [line] }
}

/**
 * Tail a Codex session file as an async iterable of `SessionEvent`s.
 *
 * Behavior mirrors the claude adapter's tailer:
 *   1. If the file doesn't exist, returns `null` (caller treats as 404).
 *   2. Yields all existing lines (filtering noise), then live-tails appends.
 *   3. Iteration ends when the consumer breaks or aborts via signal.
 */
export async function tailCodexSessionFile(
  filePath: string,
  opts: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<AsyncIterable<SessionEvent> | null> {
  if (!existsSync(filePath)) return null
  const handle = await open(filePath, 'r')
  return makeIterable(handle, opts.signal, opts.pollMs ?? 200)
}

function makeIterable(
  handle: FileHandle,
  signal: AbortSignal | undefined,
  pollMs: number,
): AsyncIterable<SessionEvent> {
  return {
    [Symbol.asyncIterator]() {
      let offset = 0
      let lineBuf = ''
      const queue: SessionEvent[] = []
      let closed = false

      async function pumpFile(): Promise<void> {
        if (closed) return
        try {
          const st = await handle.stat()
          if (closed || st.size <= offset) return
          const len = st.size - offset
          const buf = Buffer.alloc(len)
          const { bytesRead } = await handle.read(buf, 0, len, offset)
          if (closed) return
          offset += bytesRead
          lineBuf += buf.subarray(0, bytesRead).toString('utf8')
          let nl: number
          while ((nl = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, nl)
            lineBuf = lineBuf.slice(nl + 1)
            const ev = lineToEvent(line)
            if (ev) queue.push(ev)
          }
        } catch (err) {
          if (closed) return
          throw err
        }
      }

      function sleep(): Promise<void> {
        if (signal?.aborted) return Promise.resolve()
        return new Promise((resolve) => {
          const onAbort = () => {
            clearTimeout(timer)
            resolve()
          }
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
          }, pollMs)
          signal?.addEventListener('abort', onAbort, { once: true })
        })
      }

      const iter: AsyncIterator<SessionEvent> = {
        async next(): Promise<IteratorResult<SessionEvent>> {
          if (closed) return { done: true, value: undefined }
          // eslint-disable-next-line no-constant-condition
          while (true) {
            if (queue.length > 0) {
              return { value: queue.shift()!, done: false }
            }
            if (signal?.aborted) {
              await iter.return!()
              return { done: true, value: undefined }
            }
            await pumpFile()
            if (queue.length > 0) continue
            await sleep()
          }
        },
        async return(): Promise<IteratorResult<SessionEvent>> {
          if (!closed) {
            closed = true
            await handle.close().catch(() => {})
          }
          return { done: true, value: undefined }
        },
      }
      return iter
    },
  }
}

const BUSY_TAIL_BYTES = 16 * 1024

/**
 * Decide whether a Codex session is currently mid-turn by inspecting its
 * on-disk JSONL file.
 *
 * Codex writes events incrementally. The busy detection walks the tail
 * backward looking for `event_msg` lines:
 *
 *   - **Idle markers**:
 *       • `payload.type === "task_complete"` — clean end of turn
 *       • `payload.type === "turn_aborted"` — SIGPIPE / interrupted
 *
 *   - **Busy markers**:
 *       • `payload.type === "task_started"` without a subsequent
 *         `task_complete` or `turn_aborted` — turn is in flight
 *
 *   - **Empty or no file**: idle (unknown session, let the run proceed).
 *
 * SIGKILL/SIGTERM gap: same as claude — a killed process leaves no terminal
 * marker, so the session is reported as busy forever. Accepted.
 */
export async function isCodexSessionBusy(filePath: string): Promise<boolean> {
  let st
  try {
    st = await stat(filePath)
  } catch {
    return false
  }
  if (st.size === 0) return false

  const len = Math.min(BUSY_TAIL_BYTES, st.size)
  const offset = st.size - len
  const handle = await open(filePath, 'r')
  let text: string
  try {
    const buf = Buffer.alloc(len)
    const { bytesRead } = await handle.read(buf, 0, len, offset)
    text = buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close().catch(() => {})
  }

  // Drop partial first line on partial reads.
  if (offset > 0) {
    const firstNl = text.indexOf('\n')
    if (firstNl === -1) return false
    text = text.slice(firstNl + 1)
  }

  const lines = text.split('\n').filter((l) => l.length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: { type?: string; payload?: { type?: string } }
    try {
      parsed = JSON.parse(lines[i]!)
    } catch {
      continue
    }
    if (parsed.type !== 'event_msg') continue
    const pt = parsed.payload?.type
    if (pt === 'task_complete' || pt === 'turn_aborted') return false
    if (pt === 'task_started') return true
  }
  return false
}
