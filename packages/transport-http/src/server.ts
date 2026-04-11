import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { timingSafeEqual } from 'node:crypto'
import type { SessionRunner, SessionEvent } from '@zooid/agentd-core'

export interface CreateAppOptions {
  runner: SessionRunner
  /**
   * Bearer token clients must present in the `Authorization: Bearer <token>`
   * header. Compared in constant time. Generate one with `agentd --print-token`.
   */
  token: string
}

interface RunRequestBody {
  prompt: string
  session_id?: string
}

function isAuthorized(token: string, header: string | undefined): boolean {
  if (!header || !header.startsWith('Bearer ')) return false
  const provided = header.slice('Bearer '.length)
  if (provided.length !== token.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(token))
}

function parseBody(raw: unknown): RunRequestBody | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: 'body must be a JSON object' }
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.prompt !== 'string' || obj.prompt.length === 0) {
    return { error: 'missing or empty prompt' }
  }
  const out: RunRequestBody = { prompt: obj.prompt }
  if (typeof obj.session_id === 'string' && obj.session_id.length > 0) {
    out.session_id = obj.session_id
  }
  return out
}

export function createApp({ runner, token }: CreateAppOptions) {
  const app = new Hono()

  app.post('/run', async (c) => {
    // 1. Bearer auth.
    if (!isAuthorized(token, c.req.header('authorization'))) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    // 2. Parse + validate JSON body.
    const raw = await c.req.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400)
    }
    const body = parseBody(parsed)
    if ('error' in body) {
      return c.json({ error: body.error }, 400)
    }

    // 3. Pre-stream readiness check (no adapter → 503 before opening stream).
    const readiness = runner.checkReady()
    if (!readiness.ready) {
      return c.json({ error: readiness.error ?? 'not ready' }, 503)
    }

    // 4. Open the SSE stream. From here on, failures are surfaced as
    //    terminal `session.ended` events inside the 200 response.
    return streamSSE(c, async (stream) => {
      let pump: Promise<void> = Promise.resolve()

      const writeEvent = (e: SessionEvent) => {
        pump = pump.then(() =>
          stream.writeSSE({ data: JSON.stringify(e) }),
        )
      }

      try {
        await runner.run({
          prompt: body.prompt,
          session_id: body.session_id,
          onEvent: writeEvent,
        })
      } catch (err) {
        writeEvent({
          type: 'session.ended',
          exit_code: 1,
          reason: (err as Error).message,
        })
      }

      await pump
    })
  })

  return app
}
