import { describe, it, expect } from 'vitest'
import { runHook } from './hooks.js'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('runHook', () => {
  it('runs a successful hook and returns exit 0', async () => {
    const result = await runHook('echo hello', {}, process.cwd())
    expect(result.exit_code).toBe(0)
    expect(result.stdout).toContain('hello')
  })

  it('passes env vars to the hook', async () => {
    const result = await runHook(
      'echo "session=$SESSION_ID prompt=$MESSAGE_TEXT"',
      { SESSION_ID: '01JQXYZ', MESSAGE_TEXT: 'fix bug' },
      process.cwd(),
    )
    expect(result.exit_code).toBe(0)
    expect(result.stdout).toContain('session=01JQXYZ')
    expect(result.stdout).toContain('prompt=fix bug')
  })

  it('captures stderr and exit code on failure', async () => {
    const result = await runHook('echo oops >&2 && exit 2', {}, process.cwd())
    expect(result.exit_code).toBe(2)
    expect(result.stderr).toContain('oops')
  })

  it('runs in the configured workdir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentd-hook-'))
    try {
      const result = await runHook('pwd', {}, dir)
      // On macOS tmpdir resolves through /private; resolve symlinks for both sides
      expect(result.stdout.trim()).toBe(realpathSync(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('supports shell chaining with &&', async () => {
    const result = await runHook('echo one && echo two', {}, process.cwd())
    expect(result.stdout).toContain('one')
    expect(result.stdout).toContain('two')
  })
})
