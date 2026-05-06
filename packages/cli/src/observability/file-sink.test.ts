import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { JsonlSink, shouldCaptureUpdate, type Verbosity } from './file-sink.js'

describe('JsonlSink', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zooid-obs-sink-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('appends one JSON object per line and survives close+reopen', async () => {
    const path = join(dir, 'agent-docs.acp.jsonl')
    const sink1 = new JsonlSink(path)
    await sink1.write({ a: 1 })
    await sink1.write({ b: 2 })
    await sink1.close()
    const sink2 = new JsonlSink(path)
    await sink2.write({ c: 3 })
    await sink2.close()
    const text = await readFile(path, 'utf8')
    const lines = text.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('truncates string fields longer than 4 KB on a top-level cap', async () => {
    const path = join(dir, 'big.jsonl')
    const sink = new JsonlSink(path, { maxStringLen: 4096 })
    const big = 'x'.repeat(10_000)
    await sink.write({ a: big })
    await sink.close()
    const line = JSON.parse((await readFile(path, 'utf8')).trim())
    expect(line.a.length).toBeLessThanOrEqual(4096 + '…[truncated]'.length)
    expect(line.a.endsWith('…[truncated]')).toBe(true)
  })
})

describe('shouldCaptureUpdate (default verbosity)', () => {
  const cases: Array<[string, boolean]> = [
    ['tool_call', true],
    ['tool_call_update', true],
    ['plan', true],
    ['available_commands_update', true],
    ['current_mode_update', true],
    ['user_message_chunk', true],
    ['agent_message_chunk', false],
    ['agent_thought_chunk', false],
  ]
  it.each(cases)('default(%s) → %s', (variant, expected) => {
    const v: Verbosity = 'default'
    expect(shouldCaptureUpdate(v, variant)).toBe(expected)
  })

  it('verbose-thoughts captures thought chunks but not message chunks', () => {
    expect(shouldCaptureUpdate('verbose-thoughts', 'agent_thought_chunk')).toBe(true)
    expect(shouldCaptureUpdate('verbose-thoughts', 'agent_message_chunk')).toBe(false)
  })

  it('verbose captures everything', () => {
    expect(shouldCaptureUpdate('verbose', 'agent_message_chunk')).toBe(true)
    expect(shouldCaptureUpdate('verbose', 'agent_thought_chunk')).toBe(true)
  })
})
