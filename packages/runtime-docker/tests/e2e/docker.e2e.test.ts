import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

const STUB_IMAGE = 'ghcr.io/zooid-ai/budd-agent-claude-code-stub:test'
const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CLI_BIN = resolve(PKG_DIR, '../cli/dist/bin.js')

function makeToken(): string {
  return randomBytes(32).toString('hex')
}

async function waitForHealthy(port: number, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      // Cheap probe — unauthenticated POST returns 401 once the server is up.
      const res = await fetch(`http://localhost:${port}/sessions`, {
        method: 'POST',
        body: '{}',
      })
      if (res.status === 401 || res.status === 400) return
    } catch {
      // connection refused — not up yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`budd on port ${port} did not become healthy`)
}

async function startBudd(opts: {
  port: number
  token: string
  workdir: string
  extraEnv?: Record<string, string>
}): Promise<ChildProcess> {
  if (!existsSync(CLI_BIN)) {
    throw new Error(
      `budd CLI not built at ${CLI_BIN} — run \`pnpm -C packages/cli build\` first`,
    )
  }
  const child = spawn(
    'node',
    [
      CLI_BIN,
      '--runtime',
      'docker',
      '--port',
      String(opts.port),
      '--image',
      STUB_IMAGE,
      '--workdir',
      opts.workdir,
    ],
    {
      cwd: opts.workdir,
      env: {
        ...process.env,
        BUDD_TOKEN: opts.token,
        ...opts.extraEnv,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  )
  await waitForHealthy(opts.port)
  return child
}

function parseSseFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .filter((f) => f.trim().length > 0)
    .map((frame) => {
      const dataLine = frame
        .split('\n')
        .find((line) => line.startsWith('data: '))
      if (!dataLine) return null
      return JSON.parse(dataLine.slice('data: '.length))
    })
    .filter((f): f is Record<string, unknown> => f !== null)
}

beforeAll(() => {
  const dockerfile = join(PKG_DIR, 'docker/claude-stub')
  const build = spawnSync(
    'docker',
    ['build', '-t', STUB_IMAGE, dockerfile],
    { stdio: 'inherit' },
  )
  if (build.status !== 0) {
    throw new Error(
      'stub image build failed — is Docker running? See `docker info`',
    )
  }
}, 180_000)

afterAll(() => {
  spawnSync('docker', ['rmi', '-f', STUB_IMAGE], { stdio: 'ignore' })
})

describe('budd --runtime docker (e2e)', () => {
  it('runs a session inside the container and streams SSE back', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'budd-e2e-'))
    const port = 8201
    const token = makeToken()

    const budd = await startBudd({ port, token, workdir })
    try {
      const body = JSON.stringify({ prompt: 'fix the auth bug' })
      const res = await fetch(`http://localhost:${port}/sessions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body,
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')

      const text = await res.text()
      const frames = parseSseFrames(text)

      expect(frames[0]?.type).toBe('session.start')
      expect(frames[1]?.type).toBe('turn.start')
      const ended = frames[frames.length - 1]
      expect(ended?.type).toBe('turn.end')
      expect(ended?.exit_code).toBe(0)
      expect(frames.some((f) => f.type === 'stdout')).toBe(true)
    } finally {
      budd.kill('SIGTERM')
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('non-zero container exit propagates', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'budd-e2e-'))
    const port = 8202
    const token = makeToken()

    const budd = await startBudd({
      port,
      token,
      workdir,
      // STUB_EXIT_CODE is forwarded through the runtime allowlist into the
      // container, where the stub `claude` script reads it.
      extraEnv: { STUB_EXIT_CODE: '2' },
    })
    try {
      const body = JSON.stringify({ prompt: 'whatever' })
      const res = await fetch(`http://localhost:${port}/sessions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body,
      })
      const text = await res.text()
      const frames = parseSseFrames(text)
      const ended = frames[frames.length - 1]
      expect(ended?.type).toBe('turn.end')
      expect(ended?.exit_code).toBe(2)
    } finally {
      budd.kill('SIGTERM')
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('env leakage: host env vars not in the allowlist are not visible inside the container', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'budd-e2e-'))
    const port = 8203
    const token = makeToken()

    const budd = await startBudd({
      port,
      token,
      workdir,
      // SECRET_FOO is NOT in the DockerRuntime env allowlist. The stub
      // `claude` script writes its value to stderr if set, so any leak
      // would surface in the SSE response body.
      extraEnv: { SECRET_FOO: 'should-not-leak' },
    })
    try {
      const body = JSON.stringify({ prompt: 'whatever' })
      const res = await fetch(`http://localhost:${port}/sessions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body,
      })
      const text = await res.text()
      expect(text).not.toContain('should-not-leak')
    } finally {
      budd.kill('SIGTERM')
      rmSync(workdir, { recursive: true, force: true })
    }
  })
})
