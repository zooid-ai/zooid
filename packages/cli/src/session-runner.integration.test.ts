import { describe, it, expect } from 'vitest'
import {
  SessionRunner,
  type AgentAdapter,
  type SessionEvent,
  type SessionRunnerOptions,
} from '@zooid/core'
import { LocalRuntime } from '@zooid/runtime-local'
import { claudeAdapter } from '@zooid/budd-adapter-claude'
import { codexAdapter } from '@zooid/budd-adapter-codex'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// Resolve the stub `claude` fixture that ships with @zooid/budd-adapter-claude.
// We point at the source-side fixture so this works in dev (no build needed).
const FIXTURES_BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../adapter-claude/tests/fixtures/bin',
)

const CODEX_FIXTURES_BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../adapter-codex/tests/fixtures/bin',
)

function makeRunner(
  opts: {
    hooks?: { pre_turn?: string; post_turn?: string }
    adapterEnv?: Record<string, string>
    extra?: Partial<SessionRunnerOptions>
  } = {},
): SessionRunner {
  return new SessionRunner({
    runtime: new LocalRuntime(),
    adapter: claudeAdapter,
    hooks: opts.hooks ?? {},
    pathPrefix: FIXTURES_BIN,
    adapterEnv: opts.adapterEnv,
    ...opts.extra,
  })
}

describe('SessionRunner (integration with stub claude)', () => {
  it('runs a happy-path session', async () => {
    const runner = makeRunner()
    const events: SessionEvent[] = []
    const result = await runner.run({
      prompt: 'fix the auth bug',
      onEvent: (e) => events.push(e),
    })

    expect(result.exit_code).toBe(0)

    // First event: session.start with a generated id (UUID, per claudeAdapter).
    expect(events[0].type).toBe('session.start')
    expect((events[0] as { session_id: string }).session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )

    // Second event: turn.start.
    expect(events[1].type).toBe('turn.start')

    // Last event: turn.end with exit code 0.
    const ended = events[events.length - 1]
    expect(ended.type).toBe('turn.end')
    expect((ended as { exit_code: number }).exit_code).toBe(0)

    // At least one stdout event between.
    expect(events.slice(2, -1).some((e) => e.type === 'stdout')).toBe(true)
  })

  it('resume path passes --resume with the provided session_id', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'zooid-argv-'))
    const argvFile = join(tmpDir, 'argv.txt')
    try {
      const runner = makeRunner({ adapterEnv: { STUB_ARGV_FILE: argvFile } })
      await runner.run({
        prompt: 'also add tests',
        session_id: '01EXISTING',
        onEvent: () => {},
      })
      const argv = readFileSync(argvFile, 'utf8').split('\n').filter(Boolean)
      expect(argv).toContain('--resume')
      expect(argv).toContain('01EXISTING')
      expect(argv).not.toContain('--session-id')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('resume omits session.start and starts with turn.start', async () => {
    const runner = makeRunner()
    const events: SessionEvent[] = []
    await runner.run({
      prompt: 'follow up',
      session_id: '01EXISTING',
      onEvent: (e) => events.push(e),
    })
    // No session.start on resume — the client already knows the id.
    expect(events.some((e) => e.type === 'session.start')).toBe(false)
    expect(events[0].type).toBe('turn.start')
  })

  it('non-zero agent exit propagates as turn.end.exit_code', async () => {
    const runner = makeRunner({ adapterEnv: { STUB_EXIT_CODE: '2' } })
    const events: SessionEvent[] = []
    await runner.run({
      prompt: 'whatever',
      onEvent: (e) => events.push(e),
    })
    const ended = events[events.length - 1]
    expect(ended.type).toBe('turn.end')
    expect((ended as { exit_code: number }).exit_code).toBe(2)
  })

  it('pre_turn failure aborts before session.start / turn.start', async () => {
    const runner = makeRunner({
      hooks: { pre_turn: 'echo nope >&2 && exit 1' },
    })
    const events: SessionEvent[] = []
    await runner.run({
      prompt: 'whatever',
      onEvent: (e) => events.push(e),
    })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('turn.end')
    expect((events[0] as { exit_code: number }).exit_code).toBe(1)
    expect((events[0] as { reason?: string }).reason).toContain('nope')
  })

  it('post_turn failure does not change the agent exit code', async () => {
    const runner = makeRunner({ hooks: { post_turn: 'exit 99' } })
    const events: SessionEvent[] = []
    const result = await runner.run({
      prompt: 'whatever',
      onEvent: (e) => events.push(e),
    })
    expect(result.exit_code).toBe(0)
    const ended = events[events.length - 1]
    expect((ended as { exit_code: number }).exit_code).toBe(0)
  })

  it('rejects when no adapter is available', async () => {
    const runner = new SessionRunner({
      runtime: new LocalRuntime(),
      adapter: claudeAdapter,
      hooks: {},
      overridePath: '/definitely/not/a/real/dir',
    })
    await expect(
      runner.run({ prompt: 'whatever', onEvent: () => {} }),
    ).rejects.toThrow(/no agent adapter detected/)
  })

  it('checkReady returns false when no adapter is present', () => {
    const runner = new SessionRunner({
      runtime: new LocalRuntime(),
      adapter: claudeAdapter,
      hooks: {},
      overridePath: '/definitely/not/a/real/dir',
    })
    expect(runner.checkReady()).toEqual({
      ready: false,
      error: 'no agent adapter detected',
    })
  })

  it('checkReady returns true when adapter is present', () => {
    const runner = makeRunner()
    expect(runner.checkReady().ready).toBe(true)
  })
})

// ─── Deferred id strategy ─────────────────────────────────────────────────
//
// Models a CLI like Codex that mints its own session id and surfaces it
// mid-stream via a JSONL `thread.started` line. Uses an inline /bin/sh stub
// instead of a fixture binary so the test stays self-contained.

function makeDeferredAdapter(opts: {
  /** Lines the fake CLI prints, joined with \n. */
  stdout: string
  /** Captures spawn argv for assertion. */
  capturedSpawnId?: { value: string | undefined }
}): AgentAdapter {
  return {
    name: 'fake-deferred',
    isAvailable: () => true,
    prepareNewSession: () => ({ strategy: 'deferred' }),
    spawn({ session_id }) {
      if (opts.capturedSpawnId) opts.capturedSpawnId.value = session_id
      // Spawn `node -e` so the bytes (including newlines) round-trip
      // verbatim through process.stdout.write. A naïve `printf '%s' "..."`
      // shell pipeline mangles backslash escapes.
      return {
        command: process.execPath,
        args: ['-e', `process.stdout.write(${JSON.stringify(opts.stdout)})`],
      }
    },
    parseOutput(line) {
      try {
        const j = JSON.parse(line) as { type?: string; thread_id?: string }
        if (j.type === 'thread.started' && typeof j.thread_id === 'string') {
          return { kind: 'session_started', session_id: j.thread_id }
        }
        return { kind: 'message', raw: j }
      } catch {
        return { kind: 'ignore' }
      }
    },
  }
}

describe('SessionRunner — deferred id strategy', () => {
  it('holds session.start until parseOutput surfaces the id', async () => {
    const captured: { value: string | undefined } = { value: 'sentinel' }
    const stdout =
      '{"type":"thread.started","thread_id":"abc-123"}\n' +
      '{"type":"message","text":"hello"}\n'
    const runner = new SessionRunner({
      runtime: new LocalRuntime(),
      adapter: makeDeferredAdapter({ stdout, capturedSpawnId: captured }),
      hooks: {},
      // Smaller idle so the chunker flushes promptly during the test.
      idleMs: 10,
    })
    const events: SessionEvent[] = []
    const result = await runner.run({
      prompt: 'hi',
      onEvent: (e) => events.push(e),
    })

    // Adapter saw `session_id: undefined` at spawn time.
    expect(captured.value).toBeUndefined()

    // turn.start is the first event (session.start is held).
    expect(events[0].type).toBe('turn.start')

    // session.start fires exactly once, with the id from the stream.
    const starts = events.filter((e) => e.type === 'session.start')
    expect(starts).toHaveLength(1)
    expect((starts[0] as { session_id: string }).session_id).toBe('abc-123')

    // turn.end is last and exit code 0.
    const ended = events[events.length - 1]
    expect(ended.type).toBe('turn.end')
    expect((ended as { exit_code: number }).exit_code).toBe(0)

    // RunResult carries the surfaced id.
    expect(result.session_id).toBe('abc-123')
  })

  it('resume on a deferred adapter passes the id straight through and skips session.start', async () => {
    const captured: { value: string | undefined } = { value: undefined }
    const runner = new SessionRunner({
      runtime: new LocalRuntime(),
      adapter: makeDeferredAdapter({
        stdout: '{"type":"message","text":"follow up"}\n',
        capturedSpawnId: captured,
      }),
      hooks: {},
      idleMs: 10,
    })
    const events: SessionEvent[] = []
    await runner.run({
      prompt: 'follow up',
      session_id: 'abc-123',
      onEvent: (e) => events.push(e),
    })
    // Adapter received the caller-supplied id, not undefined.
    expect(captured.value).toBe('abc-123')
    // No session.start on resume — even for deferred adapters.
    expect(events.some((e) => e.type === 'session.start')).toBe(false)
    expect(events[0].type).toBe('turn.start')
  })

  it('RunResult.session_id is undefined when a deferred adapter exits before surfacing one', async () => {
    const runner = new SessionRunner({
      runtime: new LocalRuntime(),
      adapter: makeDeferredAdapter({
        // Crashes before printing thread.started.
        stdout: '{"type":"message","text":"oops"}\n',
      }),
      hooks: {},
      idleMs: 10,
    })
    const events: SessionEvent[] = []
    const result = await runner.run({
      prompt: 'hi',
      onEvent: (e) => events.push(e),
    })
    expect(events.some((e) => e.type === 'session.start')).toBe(false)
    expect(result.session_id).toBeUndefined()
  })

  it('throws if a deferred adapter does not implement parseOutput', async () => {
    const broken: AgentAdapter = {
      name: 'broken-deferred',
      isAvailable: () => true,
      prepareNewSession: () => ({ strategy: 'deferred' }),
      spawn: () => ({ command: '/bin/true', args: [] }),
      // parseOutput intentionally missing
    }
    const runner = new SessionRunner({
      runtime: new LocalRuntime(),
      adapter: broken,
      hooks: {},
    })
    await expect(
      runner.run({ prompt: 'x', onEvent: () => {} }),
    ).rejects.toThrow(/deferred session id strategy.*parseOutput/)
  })

  it('pre_turn hook env exposes SESSION_ID="" on a deferred new turn', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'zooid-defenv-'))
    const envFile = join(tmpDir, 'pre.env')
    try {
      const runner = new SessionRunner({
        runtime: new LocalRuntime(),
        adapter: makeDeferredAdapter({
          stdout: '{"type":"thread.started","thread_id":"xyz-9"}\n',
        }),
        hooks: {
          // Write SESSION_ID to a file with explicit quotes around its value
          // so we can assert it was empty (vs unset).
          pre_turn: `printf 'SID=[%s]\\n' "$SESSION_ID" > ${envFile}`,
        },
        idleMs: 10,
      })
      await runner.run({ prompt: 'hi', onEvent: () => {} })
      expect(readFileSync(envFile, 'utf8')).toBe('SID=[]\n')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('post_turn hook env exposes the id surfaced mid-stream', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'zooid-defpost-'))
    const envFile = join(tmpDir, 'post.env')
    try {
      const runner = new SessionRunner({
        runtime: new LocalRuntime(),
        adapter: makeDeferredAdapter({
          stdout: '{"type":"thread.started","thread_id":"xyz-9"}\n',
        }),
        hooks: {
          post_turn: `printf 'SID=[%s] EC=[%s]\\n' "$SESSION_ID" "$EXIT_CODE" > ${envFile}`,
        },
        idleMs: 10,
      })
      await runner.run({ prompt: 'hi', onEvent: () => {} })
      expect(readFileSync(envFile, 'utf8')).toBe('SID=[xyz-9] EC=[0]\n')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ─── Codex adapter integration ───────────────────────────────────────────

function makeCodexRunner(
  opts: {
    adapterEnv?: Record<string, string>
  } = {},
): SessionRunner {
  return new SessionRunner({
    runtime: new LocalRuntime(),
    adapter: codexAdapter,
    hooks: {},
    pathPrefix: CODEX_FIXTURES_BIN,
    adapterEnv: opts.adapterEnv,
    idleMs: 10,
  })
}

describe('SessionRunner (integration with stub codex)', () => {
  it('runs a happy-path session with deferred session id from thread.started', async () => {
    const runner = makeCodexRunner()
    const events: SessionEvent[] = []
    const result = await runner.run({
      prompt: 'fix the auth bug',
      onEvent: (e) => events.push(e),
    })

    expect(result.exit_code).toBe(0)

    // turn.start fires first (deferred: session.start is held until id surfaces).
    expect(events[0].type).toBe('turn.start')

    // session.start fires exactly once with the stub's STUB-SESSION-ID.
    const starts = events.filter((e) => e.type === 'session.start')
    expect(starts).toHaveLength(1)
    expect((starts[0] as { session_id: string }).session_id).toBe(
      'STUB-SESSION-ID',
    )

    // At least one stdout event.
    expect(events.some((e) => e.type === 'stdout')).toBe(true)

    // turn.end is last with exit code 0.
    const ended = events[events.length - 1]
    expect(ended.type).toBe('turn.end')
    expect((ended as { exit_code: number }).exit_code).toBe(0)

    // RunResult carries the surfaced id.
    expect(result.session_id).toBe('STUB-SESSION-ID')
  })

  it('resume passes session_id to the adapter', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'zooid-codex-argv-'))
    const argvFile = join(tmpDir, 'argv.txt')
    try {
      const runner = makeCodexRunner({ adapterEnv: { STUB_ARGV_FILE: argvFile } })
      await runner.run({
        prompt: 'also add tests',
        session_id: 'EXISTING-CODEX-ID',
        onEvent: () => {},
      })
      const argv = readFileSync(argvFile, 'utf8').split('\n').filter(Boolean)
      expect(argv).toContain('resume')
      expect(argv).toContain('EXISTING-CODEX-ID')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('resume omits session.start', async () => {
    const runner = makeCodexRunner()
    const events: SessionEvent[] = []
    await runner.run({
      prompt: 'follow up',
      session_id: 'EXISTING-CODEX-ID',
      onEvent: (e) => events.push(e),
    })
    expect(events.some((e) => e.type === 'session.start')).toBe(false)
    expect(events[0].type).toBe('turn.start')
  })
})

// ─── SessionRunner → SpawnConfig threading ───────────────────────────────
//
// Asserts that SessionRunner pulls workspaceReadOnly / homeReadOnly /
// sessionStateDir from its adapter and forwards extraMounts /
// workspaceReadOnlyDisable from its own opts into the spawned SpawnConfig.
// The docker runtime is where these actually become `-v` flags — but we
// don't need to spin up docker to verify the wiring.

import type { Runtime, SpawnConfig } from '@zooid/core'
import { EventEmitter } from 'node:events'

function makeFakeContainerizedRuntime(): {
  runtime: Runtime
  captured: SpawnConfig[]
} {
  const captured: SpawnConfig[] = []
  const runtime: Runtime = {
    containerized: true,
    spawn(cfg) {
      captured.push(cfg)
      const ee = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
        kill(): void
      }
      ee.stdout = new EventEmitter()
      ee.stderr = new EventEmitter()
      ee.kill = () => {}
      // Emit exit on next tick so run() resolves promptly.
      setImmediate(() => ee.emit('exit', 0))
      return ee as unknown as ReturnType<Runtime['spawn']>
    },
  }
  return { runtime, captured }
}

describe('SessionRunner → SpawnConfig threading', () => {
  it('SpawnConfig carries workspaceReadOnly, homeReadOnly, sessionStateDir from the (per-agent) adapter', async () => {
    const { runtime, captured } = makeFakeContainerizedRuntime()
    const runner = new SessionRunner({
      runtime,
      adapter: claudeAdapter,
      hooks: {},
      cwd: '/some/workspace',
      idleMs: 1,
    })
    await runner.run({ prompt: 'hi', onEvent: () => {} })
    const cfg = captured[0]
    expect(cfg.workspaceReadOnly).toEqual(['CLAUDE.md', '.claude'])
    expect(cfg.homeReadOnly).toEqual(['.claude/settings.json'])
    expect(cfg.sessionStateDir).toBe('.claude/projects/-workspace')
  })

  it('SpawnConfig forwards extraMounts and workspaceReadOnlyDisable from runner opts', async () => {
    const { runtime, captured } = makeFakeContainerizedRuntime()
    const runner = new SessionRunner({
      runtime,
      adapter: claudeAdapter,
      hooks: {},
      cwd: '/some/workspace',
      idleMs: 1,
      extraMounts: [{ path: '/abs/cache', target: '/cache', mode: 'rw' }],
      workspaceReadOnlyDisable: ['CLAUDE.md'],
    })
    await runner.run({ prompt: 'hi', onEvent: () => {} })
    const cfg = captured[0]
    expect(cfg.extraMounts).toEqual([
      { path: '/abs/cache', target: '/cache', mode: 'rw' },
    ])
    expect(cfg.workspaceReadOnlyDisable).toEqual(['CLAUDE.md'])
  })
})
