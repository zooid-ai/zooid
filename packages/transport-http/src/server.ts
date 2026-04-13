import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { timingSafeEqual } from 'node:crypto'
import type { SessionRunner, SessionEvent } from '@zooid/budd-core'

export interface CreateAppOptions {
  runner: SessionRunner
  /**
   * Bearer token clients must present in the `Authorization: Bearer <token>`
   * header. Compared in constant time. Generate one with `budd --print-token`.
   */
  token: string
}

// Lowercase UUID — matches what the claude adapter mints with crypto.randomUUID().
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface PromptBody {
  prompt: string
}

function isAuthorized(token: string, header: string | undefined): boolean {
  if (!header || !header.startsWith('Bearer ')) return false
  const provided = header.slice('Bearer '.length)
  if (provided.length !== token.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(token))
}

function parsePromptBody(raw: unknown): PromptBody | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: 'body must be a JSON object' }
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.prompt !== 'string' || obj.prompt.length === 0) {
    return { error: 'missing or empty prompt' }
  }
  return { prompt: obj.prompt }
}

async function readJson(c: Context): Promise<unknown | { error: string }> {
  const raw = await c.req.text()
  try {
    return JSON.parse(raw)
  } catch {
    return { error: 'body must be valid JSON' }
  }
}

export function createApp({ runner, token }: CreateAppOptions) {
  const app = new Hono()

  /**
   * Stream a runner.run() invocation as Server-Sent Events.
   *
   * Shared between `POST /sessions` (new session) and `POST /sessions/:id/turns`
   * (resume). Once we open the SSE stream the response is committed to 200 —
   * any error during the run surfaces as a terminal `turn.end` frame instead
   * of a non-200 status.
   */
  function streamRun(
    c: Context,
    args: { prompt: string; session_id?: string },
  ) {
    return streamSSE(c, async (stream) => {
      let pump: Promise<void> = Promise.resolve()
      const writeEvent = (e: SessionEvent) => {
        pump = pump.then(() => stream.writeSSE({ data: JSON.stringify(e) }))
      }
      try {
        await runner.run({
          prompt: args.prompt,
          session_id: args.session_id,
          onEvent: writeEvent,
        })
      } catch (err) {
        writeEvent({
          type: 'turn.end',
          exit_code: 1,
          reason: (err as Error).message,
        })
      }
      await pump
    })
  }

  /**
   * POST /sessions — start a new agent session.
   *
   * Body: `{ "prompt": "..." }`. The runner asks the adapter to mint a fresh
   * session id (preassigned strategy) or watches for one mid-stream (deferred
   * strategy). Either way the id is surfaced via the `session.start` SSE event.
   */
  app.post('/sessions', async (c) => {
    if (!isAuthorized(token, c.req.header('authorization'))) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const parsed = await readJson(c)
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      return c.json({ error: (parsed as { error: string }).error }, 400)
    }
    const body = parsePromptBody(parsed)
    if ('error' in body) {
      return c.json({ error: body.error }, 400)
    }
    const readiness = runner.checkReady()
    if (!readiness.ready) {
      return c.json({ error: readiness.error ?? 'not ready' }, 503)
    }
    return streamRun(c, { prompt: body.prompt })
  })

  /**
   * POST /sessions/:id/turns — append a turn to an existing session.
   *
   * Body: `{ "prompt": "..." }`. The id in the path is passed to the adapter
   * as the resume id (`claude --resume <id>`, `codex exec resume <id>`).
   * No `session.start` event is emitted on resume — the client already knows
   * the id.
   *
   * The id must be a UUID. We validate at the route layer so a bad id fails
   * fast with 400 instead of leaking the format requirement out of the
   * Claude adapter via a mid-stream `turn.end`.
   */
  app.post('/sessions/:id/turns', async (c) => {
    if (!isAuthorized(token, c.req.header('authorization'))) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const id = c.req.param('id')
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'session id must be a UUID' }, 400)
    }
    const parsed = await readJson(c)
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      return c.json({ error: (parsed as { error: string }).error }, 400)
    }
    const body = parsePromptBody(parsed)
    if ('error' in body) {
      return c.json({ error: body.error }, 400)
    }
    const readiness = runner.checkReady()
    if (!readiness.ready) {
      return c.json({ error: readiness.error ?? 'not ready' }, 503)
    }
    // Concurrency guard. Claude Code does NOT detect concurrent --resume on
    // the same session id — it silently forks the conversation tree (verified
    // empirically: two simultaneous turns both succeed and write interleaved
    // entries into the same JSONL, with claude inserting a synthetic
    // assistant stop to make the fork legal). The adapter watches the on-disk
    // session file for terminal markers; if a turn is still in flight, we
    // return 409 instead of letting the second one race. The Location header
    // and `stream` body field point at the reattach endpoint so a polite
    // client can subscribe to the in-flight turn rather than retrying blindly.
    if (await runner.isSessionBusy(id)) {
      c.header('Location', `/sessions/${id}/events`)
      return c.json(
        { error: 'session is busy', stream: `/sessions/${id}/events` },
        409,
      )
    }
    return streamRun(c, { prompt: body.prompt, session_id: id })
  })

  /**
   * GET /sessions/:id/events — tap into a session's event stream.
   *
   * Uses the adapter's `openStream` to live-tail whatever persistent state
   * the underlying CLI keeps (Claude Code: the `.jsonl` session file under
   * `~/.claude/projects/...`; future adapters: whatever they want — budd
   * doesn't care about the storage shape).
   *
   * Use cases:
   *   - **Reattach after disconnect.** Client lost the original POST stream;
   *     opens this to pick up where it left off.
   *   - **Multi-instance / horizontally-scaled budd.** Replica A is running
   *     a turn; replica B serves a GET against the same id and reads from
   *     the shared volume (FUSE / Fly volume / EFS) where the session file
   *     lives.
   *   - **History inspection.** Anyone with a session id can read the full
   *     event log without spawning the agent.
   *
   * Returns 404 when there's no readable stream for the id (adapter doesn't
   * support it, or no state exists). The 404 vs 200 distinction is the only
   * thing the client sees — what kind of storage the adapter uses, and
   * whether the session is "live" or "ended", are deliberately invisible.
   */
  app.get('/sessions/:id/events', async (c) => {
    if (!isAuthorized(token, c.req.header('authorization'))) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const id = c.req.param('id')
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'session id must be a UUID' }, 400)
    }

    const stream = await runner.openSessionStream(id)
    if (!stream) {
      return c.json({ error: 'session not found' }, 404)
    }

    return streamSSE(c, async (sseStream) => {
      // for-await calls iter.return() automatically on break/throw, which
      // closes the underlying file handle in the claude adapter. No manual
      // teardown needed here.
      try {
        for await (const ev of stream) {
          if (sseStream.aborted) break
          await sseStream.writeSSE({ data: JSON.stringify(ev) })
        }
      } catch {
        // Client disconnected mid-write, or the adapter's iterator threw —
        // either way the stream is over. Nothing to surface.
      }
    })
  })

  return app
}
