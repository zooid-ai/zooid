import { describe, it, expect } from 'vitest'
import { createApp } from './server.js'
import { parseEventStream } from './sse.js'
import { SessionRunner, type SessionEvent } from '@zooid/budd-core'
import { LocalRuntime } from '@zooid/budd-runtime-local'
import { claudeAdapter } from '@zooid/budd-adapter-claude'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const FIXTURES_BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../adapter-claude/tests/fixtures/bin',
)

const TOKEN = 'test-token-0123456789abcdef'

// A real-shaped UUID for resume tests. The route validates UUID format so we
// can't just use "01EXISTING" anymore.
const EXISTING_ID = '11111111-2222-3333-4444-555555555555'

function makeApp(
  opts: {
    hooks?: { pre_turn?: string; post_turn?: string }
    adapterEnv?: Record<string, string>
    noAdapter?: boolean
  } = {},
) {
  const runner = new SessionRunner({
    runtime: new LocalRuntime(),
    adapters: [claudeAdapter],
    hooks: opts.hooks ?? {},
    pathPrefix: opts.noAdapter ? undefined : FIXTURES_BIN,
    overridePath: opts.noAdapter ? '/definitely/not/a/real/dir' : undefined,
    adapterEnv: opts.adapterEnv,
  })
  return createApp({ runner, token: TOKEN })
}

async function postJson(
  app: ReturnType<typeof createApp>,
  path: string,
  body: object,
  authOverride?: string | null,
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authOverride !== null) {
    headers.authorization = authOverride ?? `Bearer ${TOKEN}`
  }
  return app.request(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

async function readSseStream(res: Response): Promise<SessionEvent[]> {
  const text = await res.text()
  return parseEventStream(text)
}

describe('POST /sessions', () => {
  it('happy path: 200, event-stream, session.start → turn.start → stdout → turn.end', async () => {
    const app = makeApp()
    const res = await postJson(app, '/sessions', { prompt: 'fix the auth bug' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const events = await readSseStream(res)
    expect(events[0].type).toBe('session.start')
    expect((events[0] as { session_id: string }).session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(events[1].type).toBe('turn.start')
    const ended = events[events.length - 1]
    expect(ended.type).toBe('turn.end')
    expect((ended as { exit_code: number }).exit_code).toBe(0)
    expect(events.slice(2, -1).some((e) => e.type === 'stdout')).toBe(true)
  })

  it('passes --session-id (not --resume) to the adapter on a new session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'budd-argv-'))
    const argvFile = join(dir, 'argv.txt')
    try {
      const app = makeApp({ adapterEnv: { STUB_ARGV_FILE: argvFile } })
      const res = await postJson(app, '/sessions', { prompt: 'fix bug' })
      await res.text() // drain
      const argv = readFileSync(argvFile, 'utf8').split('\n').filter(Boolean)
      expect(argv).toContain('--session-id')
      expect(argv).not.toContain('--resume')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('wrong token → 401', async () => {
    const app = makeApp()
    const res = await postJson(
      app,
      '/sessions',
      { prompt: 'fix bug' },
      'Bearer not-the-token',
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('missing Authorization header → 401', async () => {
    const app = makeApp()
    const res = await postJson(app, '/sessions', { prompt: 'fix bug' }, null)
    expect(res.status).toBe(401)
  })

  it('non-Bearer scheme → 401', async () => {
    const app = makeApp()
    const res = await postJson(
      app,
      '/sessions',
      { prompt: 'fix bug' },
      `Basic ${TOKEN}`,
    )
    expect(res.status).toBe(401)
  })

  it('Bearer with wrong-length token → 401 (constant-time guard)', async () => {
    const app = makeApp()
    const res = await postJson(
      app,
      '/sessions',
      { prompt: 'fix bug' },
      'Bearer short',
    )
    expect(res.status).toBe(401)
  })

  it('missing prompt → 400', async () => {
    const app = makeApp()
    const res = await postJson(app, '/sessions', {})
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/prompt/),
    })
  })

  it('non-JSON body → 400', async () => {
    const app = makeApp()
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('no adapter available → 503', async () => {
    const app = makeApp({ noAdapter: true })
    const res = await postJson(app, '/sessions', { prompt: 'fix bug' })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/no agent adapter/),
    })
  })

  it('pre_turn failure → 200 event-stream with turn.end only', async () => {
    const app = makeApp({ hooks: { pre_turn: 'echo nope >&2 && exit 1' } })
    const res = await postJson(app, '/sessions', { prompt: 'fix bug' })
    expect(res.status).toBe(200)
    const events = await readSseStream(res)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('turn.end')
    expect((events[0] as { exit_code: number }).exit_code).toBe(1)
    expect((events[0] as { reason?: string }).reason).toContain('nope')
  })

  it('agent non-zero exit → turn.end with that exit code', async () => {
    const app = makeApp({ adapterEnv: { STUB_EXIT_CODE: '2' } })
    const res = await postJson(app, '/sessions', { prompt: 'fix bug' })
    const events = await readSseStream(res)
    const ended = events[events.length - 1]
    expect((ended as { exit_code: number }).exit_code).toBe(2)
  })
})

describe('POST /sessions/:id/turns', () => {
  it('passes --resume <id> to the adapter and omits session.start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'budd-argv-'))
    const argvFile = join(dir, 'argv.txt')
    try {
      const app = makeApp({ adapterEnv: { STUB_ARGV_FILE: argvFile } })
      const res = await postJson(app, `/sessions/${EXISTING_ID}/turns`, {
        prompt: 'also add tests',
      })
      const events = await readSseStream(res)

      const argv = readFileSync(argvFile, 'utf8').split('\n').filter(Boolean)
      expect(argv).toContain('--resume')
      expect(argv).toContain(EXISTING_ID)
      expect(argv).not.toContain('--session-id')

      // No session.start on resume — turn.start is the first event.
      expect(events[0].type).toBe('turn.start')
      expect(events.some((e) => e.type === 'session.start')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('non-UUID id → 400', async () => {
    const app = makeApp()
    const res = await postJson(app, '/sessions/not-a-uuid/turns', {
      prompt: 'whatever',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/UUID/),
    })
  })

  it('wrong token → 401', async () => {
    const app = makeApp()
    const res = await postJson(
      app,
      `/sessions/${EXISTING_ID}/turns`,
      { prompt: 'x' },
      'Bearer not-the-token',
    )
    expect(res.status).toBe(401)
  })

  it('missing prompt → 400', async () => {
    const app = makeApp()
    const res = await postJson(app, `/sessions/${EXISTING_ID}/turns`, {})
    expect(res.status).toBe(400)
  })

  it('no adapter available → 503', async () => {
    const app = makeApp({ noAdapter: true })
    const res = await postJson(app, `/sessions/${EXISTING_ID}/turns`, {
      prompt: 'x',
    })
    expect(res.status).toBe(503)
  })
})

describe('legacy /run is gone', () => {
  it('POST /run → 404', async () => {
    const app = makeApp()
    const res = await postJson(app, '/run', { prompt: 'fix bug' })
    expect(res.status).toBe(404)
  })
})

// ─── GET /sessions/:id/events ────────────────────────────────────────────
//
// The HTTP route delegates to runner.openSessionStream, which delegates to
// adapter.openStream. We don't want this test file to depend on Claude Code's
// real on-disk file layout — that's covered in adapter-claude/session-file.test.ts.
// Here we use a tiny fake adapter that returns a fixed async iterable, so the
// tests are about the *route shape* (auth, UUID validation, 404 vs 200, SSE
// framing) not about JSONL parsing.

import type { AgentAdapter, SessionRunnerOptions } from '@zooid/budd-core'

function makeFakeStreamAdapter(opts: {
  events?: SessionEvent[] | null // null = openStream returns null (404 case)
  busy?: boolean // makes isSessionBusy return true (for 409 tests)
}): AgentAdapter {
  return {
    name: 'fake-stream',
    isAvailable: () => true,
    prepareNewSession: () => ({ strategy: 'preassigned', session_id: 'fake' }),
    spawn: () => ({ command: '/bin/true', args: [] }),
    async openStream() {
      if (opts.events === null) return null
      const evs = opts.events ?? []
      return {
        async *[Symbol.asyncIterator]() {
          for (const e of evs) yield e
        },
      }
    },
    async isSessionBusy() {
      return opts.busy === true
    },
  }
}

function makeAppWithAdapter(adapter: AgentAdapter, extra: Partial<SessionRunnerOptions> = {}) {
  const runner = new SessionRunner({
    runtime: new LocalRuntime(),
    adapters: [adapter],
    hooks: {},
    pathPrefix: FIXTURES_BIN, // satisfies isAvailable detection
    ...extra,
  })
  return createApp({ runner, token: TOKEN })
}

describe('GET /sessions/:id/events', () => {
  const ID = '11111111-2222-3333-4444-555555555555'

  it('streams events from the adapter as SSE', async () => {
    const events: SessionEvent[] = [
      { type: 'turn.start' },
      { type: 'stdout', chunks: ['{"type":"user","message":"hi"}'] },
      { type: 'stdout', chunks: ['{"type":"assistant","content":"hello"}'] },
      { type: 'turn.end', exit_code: 0 },
    ]
    const app = makeAppWithAdapter(makeFakeStreamAdapter({ events }))
    const res = await app.request(`/sessions/${ID}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const parsed = await readSseStream(res)
    expect(parsed).toEqual(events)
  })

  it('returns 404 when the adapter has no stream for the id', async () => {
    const app = makeAppWithAdapter(makeFakeStreamAdapter({ events: null }))
    const res = await app.request(`/sessions/${ID}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/not found/),
    })
  })

  it('returns 404 when the adapter does not implement openStream', async () => {
    // claudeAdapter does implement it, but its real implementation will return
    // null because no session file exists for this id under cwd. Same outcome
    // for the client either way: 404.
    const app = makeApp()
    const res = await app.request(`/sessions/${ID}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(404)
  })

  it('non-UUID id → 400', async () => {
    const app = makeAppWithAdapter(makeFakeStreamAdapter({ events: [] }))
    const res = await app.request('/sessions/not-a-uuid/events', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(400)
  })

  it('wrong token → 401', async () => {
    const app = makeAppWithAdapter(makeFakeStreamAdapter({ events: [] }))
    const res = await app.request(`/sessions/${ID}/events`, {
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.status).toBe(401)
  })

  it('missing Authorization → 401', async () => {
    const app = makeAppWithAdapter(makeFakeStreamAdapter({ events: [] }))
    const res = await app.request(`/sessions/${ID}/events`)
    expect(res.status).toBe(401)
  })
})

// ─── concurrency guard ────────────────────────────────────────────────────
//
// Claude Code does NOT detect concurrent --resume on the same session id —
// it silently forks the conversation tree. The transport's defense is to
// ask the adapter `isSessionBusy(id, cwd)` before letting a resume through;
// if the session is mid-turn, return 409 with a `Location` header pointing
// at the reattach endpoint instead.

describe('POST /sessions/:id/turns concurrency guard', () => {
  const ID = '11111111-2222-3333-4444-555555555555'

  it('returns 409 + Location header when the adapter reports the session busy', async () => {
    // The 409 short-circuits before streamRun, so the fake adapter's spawn
    // is never reached — that's the whole point of the guard.
    const app = makeAppWithAdapter(
      makeFakeStreamAdapter({ events: [], busy: true }),
    )
    const res = await app.request(`/sessions/${ID}/turns`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ prompt: 'hi' }),
    })
    expect(res.status).toBe(409)
    expect(res.headers.get('location')).toBe(`/sessions/${ID}/events`)
    expect(await res.json()).toEqual({
      error: 'session is busy',
      stream: `/sessions/${ID}/events`,
    })
  })

  // Idle path (busy=false) is already covered by every existing
  // `POST /sessions/:id/turns` test in this file — they all run against
  // claudeAdapter, whose real isSessionBusy returns false because the
  // session id never has a real on-disk JSONL under the temp HOME.
  //
  // Likewise, POST /sessions never consults isSessionBusy (a fresh
  // session id can't race itself), so no need to test it here.
})
