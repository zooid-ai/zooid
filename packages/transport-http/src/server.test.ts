import { describe, it, expect } from 'vitest'
import { createApp } from './server.js'
import { parseEventStream } from './sse.js'
import { SessionRunner, type SessionEvent } from '@zooid/agentd-core'
import { LocalRuntime } from '@zooid/agentd-runtime-local'
import { claudeAdapter } from '@zooid/agentd-adapter-claude'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const FIXTURES_BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../adapter-claude/tests/fixtures/bin',
)

const TOKEN = 'test-token-0123456789abcdef'

function makeApp(
  opts: {
    hooks?: { pre_start?: string; post_end?: string }
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

async function postRun(
  app: ReturnType<typeof createApp>,
  body: object,
  authOverride?: string | null,
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authOverride !== null) {
    headers.authorization = authOverride ?? `Bearer ${TOKEN}`
  }
  return app.request('/run', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

async function readSseStream(res: Response): Promise<SessionEvent[]> {
  const text = await res.text()
  return parseEventStream(text)
}

describe('POST /run', () => {
  it('happy path: 200, event-stream, session.started → stdout → session.ended', async () => {
    const app = makeApp()
    const res = await postRun(app, { prompt: 'fix the auth bug' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const events = await readSseStream(res)
    expect(events[0].type).toBe('session.started')
    expect((events[0] as { session_id: string }).session_id).toMatch(
      /^[0-9A-Z]{26}$/,
    )
    const ended = events[events.length - 1]
    expect(ended.type).toBe('session.ended')
    expect((ended as { exit_code: number }).exit_code).toBe(0)
    expect(events.slice(1, -1).some((e) => e.type === 'stdout')).toBe(true)
  })

  it('resume path: passes --resume with provided session_id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentd-argv-'))
    const argvFile = join(dir, 'argv.txt')
    try {
      const app = makeApp({ adapterEnv: { STUB_ARGV_FILE: argvFile } })
      const res = await postRun(app, {
        prompt: 'also add tests',
        session_id: '01EXISTING',
      })
      await res.text() // drain

      const argv = readFileSync(argvFile, 'utf8').split('\n').filter(Boolean)
      expect(argv).toContain('--resume')
      expect(argv).toContain('01EXISTING')
      expect(argv).not.toContain('--session-id')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('wrong token → 401', async () => {
    const app = makeApp()
    const res = await postRun(app, { prompt: 'fix bug' }, 'Bearer not-the-token')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('missing Authorization header → 401', async () => {
    const app = makeApp()
    const res = await postRun(app, { prompt: 'fix bug' }, null)
    expect(res.status).toBe(401)
  })

  it('non-Bearer scheme → 401', async () => {
    const app = makeApp()
    const res = await postRun(app, { prompt: 'fix bug' }, `Basic ${TOKEN}`)
    expect(res.status).toBe(401)
  })

  it('Bearer with wrong-length token → 401 (constant-time guard)', async () => {
    const app = makeApp()
    const res = await postRun(app, { prompt: 'fix bug' }, 'Bearer short')
    expect(res.status).toBe(401)
  })

  it('missing prompt → 400', async () => {
    const app = makeApp()
    const res = await postRun(app, {})
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/prompt/),
    })
  })

  it('non-JSON body → 400', async () => {
    const app = makeApp()
    const res = await app.request('/run', {
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
    const res = await postRun(app, { prompt: 'fix bug' })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/no agent adapter/),
    })
  })

  it('pre_start failure → 200 event-stream with session.ended only', async () => {
    const app = makeApp({ hooks: { pre_start: 'echo nope >&2 && exit 1' } })
    const res = await postRun(app, { prompt: 'fix bug' })
    expect(res.status).toBe(200)
    const events = await readSseStream(res)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('session.ended')
    expect((events[0] as { exit_code: number }).exit_code).toBe(1)
    expect((events[0] as { reason?: string }).reason).toContain('nope')
  })

  it('agent non-zero exit → session.ended with that exit code', async () => {
    const app = makeApp({ adapterEnv: { STUB_EXIT_CODE: '2' } })
    const res = await postRun(app, { prompt: 'fix bug' })
    const events = await readSseStream(res)
    const ended = events[events.length - 1]
    expect((ended as { exit_code: number }).exit_code).toBe(2)
  })
})
