import { existsSync } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@zooid/budd-core'

/**
 * Compute the on-disk path Claude Code uses for a given session id under a
 * given working directory.
 *
 * Empirical layout (verified against `~/.claude/projects/` on a real install):
 *
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * The cwd is encoded by replacing every `/` with `-`. The leading slash
 * becomes a leading dash:
 *
 *   /Users/ori/Code/z       → -Users-ori-Code-z
 *   /workspace              → -workspace
 *
 * No I/O — pure path computation. Returns a path even if the file doesn't
 * exist; callers should test for existence (or just open and handle ENOENT).
 *
 * `homeDir` is overridable for tests so we can point at a temp HOME without
 * mutating `process.env.HOME`.
 */
export function claudeSessionFilePath(
  id: string,
  cwd: string,
  homeDir: string = homedir(),
): string {
  const normalized = cwd.replace(/\/+$/, '') // strip trailing slashes
  const encoded = normalized.replace(/\//g, '-')
  return join(homeDir, '.claude', 'projects', encoded, `${id}.jsonl`)
}

/**
 * Map one JSONL line from Claude Code's session file to a `SessionEvent`,
 * or `null` if the line should be skipped (bookkeeping noise).
 *
 * Claude Code's session JSONL is much richer than our `SessionEvent` schema —
 * each line carries `parentUuid`, `message`, `usage`, `gitBranch`, etc. We
 * intentionally do *not* try to lossy-translate it. Instead we forward each
 * meaningful line verbatim as a single `stdout` chunk so consumers can parse
 * the full structure themselves.
 *
 * The only filtering: skip `queue-operation` lines (internal claude code
 * bookkeeping for its input queue) since they aren't part of the conversation.
 */
function lineToEvent(line: string): SessionEvent | null {
  if (line.length === 0) return null
  let parsed: { type?: unknown }
  try {
    parsed = JSON.parse(line)
  } catch {
    // Truncated mid-write or corrupted — skip rather than crash the stream.
    return null
  }
  if (parsed.type === 'queue-operation') return null
  return { type: 'stdout', chunks: [line] }
}

/**
 * Tail a Claude Code session file as an async iterable of `SessionEvent`s.
 *
 * Behavior:
 *   1. If the file doesn't exist at call time, returns `null`. The caller
 *      treats this as 404.
 *   2. Otherwise, yields all existing lines (skipping `queue-operation`),
 *      then live-tails new appends.
 *   3. Iteration ends when the consumer breaks out of the loop or aborts via
 *      `signal`. There is no built-in idle timeout — the file is the source
 *      of truth and the consumer (typically an SSE handler) decides when
 *      they're done. For HTTP this naturally ties to client disconnect.
 *
 * Implementation: poll-based. We hold a single read file handle and poll
 * its stat for size growth on a fixed interval. Polling is simpler and more
 * portable than `fs.watch` (which has different semantics on macOS / Linux /
 * shared volumes like FUSE) and the latency cost (one poll interval) is
 * fine for SSE.
 */
export async function tailClaudeSessionFile(
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
  // Per-iterator state. Each call to [Symbol.asyncIterator] returns a fresh
  // iterator with its own offset / line buffer / pending queue, so multiple
  // simultaneous taps on the same file (e.g. multiple GETs) don't interfere.
  // We share the FileHandle though — the consumer that closes it (via
  // .return()) closes it for everyone. In practice an iterator is opened
  // once per HTTP request and not shared.
  return {
    [Symbol.asyncIterator]() {
      let offset = 0
      let lineBuf = ''
      const queue: SessionEvent[] = []
      let closed = false

      async function pumpFile(): Promise<void> {
        if (closed) return
        try {
          const stat = await handle.stat()
          if (closed || stat.size <= offset) return
          const len = stat.size - offset
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
          // Handle was closed via .return() while we were mid-await — that
          // surfaces as EBADF. Treat it as a graceful end of iteration.
          if (closed) return
          throw err
        }
      }

      // Sleep for pollMs but wake immediately on abort.
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
          // Drain the queue first, then pump and (if still empty) sleep.
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

/**
 * How many bytes from the end of the session file to read when checking
 * busy state. Claude Code's terminal markers (`last-prompt`, `turn_duration`,
 * the synthetic API-error assistant message) are all small (well under 1 KiB),
 * and they always sit at the very tail. 16 KiB easily covers them even after
 * a multi-turn conversation, without paying to read multi-megabyte history.
 */
const BUSY_TAIL_BYTES = 16 * 1024

/**
 * Decide whether a Claude Code session is currently mid-turn by inspecting
 * its on-disk JSONL file.
 *
 * Empirically (verified by killing real `claude -p` runs with various signals
 * and inspecting the resulting files), Claude Code writes the assistant
 * message to the JSONL only after the turn completes — there is no streaming
 * write. So the file's tail is enough to distinguish "in flight" from "done":
 *
 *   - **Idle markers** (any of these as the most recent verdict-bearing line):
 *       • `{type:"last-prompt"}` — written by the headless `-p` mode at end
 *         of turn AND by the signal handler on SIGTERM/SIGINT.
 *       • `{type:"system",subtype:"turn_duration"}` — written by interactive
 *         mode at end of turn.
 *       • `{type:"assistant", message:{stop_reason:"end_turn"|"stop_sequence"
 *         |"max_tokens"|"refusal"|...}}` — clean completion (or the synthetic
 *         API-error assistant message, which has stop_reason: "stop_sequence"
 *         and `isApiErrorMessage: true`).
 *       • `{type:"user", message:{content:"[Request interrupted by user]"}}`
 *         — explicit cancellation marker, written by SIGINT after `last-prompt`.
 *
 *   - **Busy markers**:
 *       • `{type:"assistant"}` with `stop_reason: "tool_use"` (model is waiting
 *         on a tool result) or `null`/missing (message still being assembled).
 *       • `{type:"user"}` with normal prompt content (turn is in flight).
 *
 *   - **Empty or no file**: idle. A brand-new session id with no on-disk
 *     state isn't "busy", just unknown — let the run proceed.
 *
 * Walking happens from the end of the tail backward; the first verdict-bearing
 * line wins. Lines that aren't conversational (`queue-operation`, `attachment`,
 * `hook_success`, etc.) are skipped.
 *
 * **SIGKILL gap**: a `kill -9`'d (or OOM-killed, or host-crashed) claude
 * process leaves the file dangling at `user → attachment → ⟂` with no
 * terminal marker. Such sessions are reported as busy and will return 409
 * forever from the HTTP transport. This is intentional and accepted — the
 * operator can resolve the stuck session by killing the JSONL file or by
 * having the user point at a new session id.
 */
export async function isClaudeSessionBusy(filePath: string): Promise<boolean> {
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

  // If we did a partial-read (offset > 0), the tail starts mid-line. Drop
  // everything up to the first newline so JSON.parse doesn't choke on a
  // truncated record.
  if (offset > 0) {
    const firstNl = text.indexOf('\n')
    if (firstNl === -1) return false
    text = text.slice(firstNl + 1)
  }

  const lines = text.split('\n').filter((l) => l.length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(lines[i]!) as Record<string, unknown>
    } catch {
      continue
    }
    const t = parsed.type
    if (t === 'last-prompt') return false
    if (
      t === 'system' &&
      (parsed as { subtype?: unknown }).subtype === 'turn_duration'
    ) {
      return false
    }
    if (t === 'assistant') {
      const msg = (parsed as { message?: { stop_reason?: unknown } }).message
      const sr = msg?.stop_reason
      if (sr == null || sr === 'tool_use') return true
      return false
    }
    if (t === 'user') {
      if (containsInterruptMarker((parsed as { message?: unknown }).message)) {
        return false
      }
      return true
    }
    // Otherwise: queue-operation, attachment, hook_success, etc. — keep walking.
  }
  return false
}

function containsInterruptMarker(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const content = (message as { content?: unknown }).content
  const NEEDLE = '[Request interrupted by user]'
  if (typeof content === 'string') return content.includes(NEEDLE)
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string' &&
        ((part as { text: string }).text).includes(NEEDLE)
      ) {
        return true
      }
    }
  }
  return false
}
