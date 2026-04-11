import { describe, it, expect } from 'vitest'
import {
  SessionRunner,
  type SessionEvent,
  type SessionRunnerOptions,
} from '@zooid/agentd-core'
import { LocalRuntime } from '@zooid/agentd-runtime-local'
import { claudeAdapter } from '@zooid/agentd-adapter-claude'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// Resolve the stub `claude` fixture that ships with @agentd/adapter-claude.
// We point at the source-side fixture so this works in dev (no build needed).
const FIXTURES_BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../adapter-claude/tests/fixtures/bin',
)

function makeRunner(
  opts: {
    hooks?: { pre_start?: string; post_end?: string }
    adapterEnv?: Record<string, string>
    extra?: Partial<SessionRunnerOptions>
  } = {},
): SessionRunner {
  return new SessionRunner({
    runtime: new LocalRuntime(),
    adapters: [claudeAdapter],
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

    // First event: session.started with a generated id.
    expect(events[0].type).toBe('session.started')
    expect((events[0] as { session_id: string }).session_id).toMatch(
      /^[0-9A-Z]{26}$/,
    )

    // Last event: session.ended with exit code 0.
    const ended = events[events.length - 1]
    expect(ended.type).toBe('session.ended')
    expect((ended as { exit_code: number }).exit_code).toBe(0)

    // At least one stdout event between.
    expect(events.slice(1, -1).some((e) => e.type === 'stdout')).toBe(true)
  })

  it('resume path passes --resume with the provided session_id', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'agentd-argv-'))
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

  it('session.started echoes the caller-provided session_id on resume', async () => {
    const runner = makeRunner()
    const events: SessionEvent[] = []
    await runner.run({
      prompt: 'follow up',
      session_id: '01EXISTING',
      onEvent: (e) => events.push(e),
    })
    expect((events[0] as { session_id: string }).session_id).toBe('01EXISTING')
  })

  it('non-zero agent exit propagates as session.ended.exit_code', async () => {
    const runner = makeRunner({ adapterEnv: { STUB_EXIT_CODE: '2' } })
    const events: SessionEvent[] = []
    await runner.run({
      prompt: 'whatever',
      onEvent: (e) => events.push(e),
    })
    const ended = events[events.length - 1]
    expect(ended.type).toBe('session.ended')
    expect((ended as { exit_code: number }).exit_code).toBe(2)
  })

  it('pre_start failure aborts before session.started', async () => {
    const runner = makeRunner({
      hooks: { pre_start: 'echo nope >&2 && exit 1' },
    })
    const events: SessionEvent[] = []
    await runner.run({
      prompt: 'whatever',
      onEvent: (e) => events.push(e),
    })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('session.ended')
    expect((events[0] as { exit_code: number }).exit_code).toBe(1)
    expect((events[0] as { reason?: string }).reason).toContain('nope')
  })

  it('post_end failure does not change the agent exit code', async () => {
    const runner = makeRunner({ hooks: { post_end: 'exit 99' } })
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
      adapters: [claudeAdapter],
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
      adapters: [claudeAdapter],
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
