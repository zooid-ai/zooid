import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { runLogs, type LogsFlags } from './logs.js'

async function fixtureDay(
  dataDir: string,
  day: string,
  files: Record<string, string>,
): Promise<void> {
  const dir = join(dataDir, 'logs', day)
  await mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content)
  }
}

describe('runLogs', () => {
  let dataDir: string
  let stdout: string[]
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'zooid-obs-cmd-'))
    stdout = []
  })
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  function run(flags: Partial<LogsFlags> = {}): Promise<void> {
    return runLogs({
      dataDir,
      writer: (s) => {
        stdout.push(s)
      },
      now: new Date('2026-05-06T10:00:00Z'),
      ...flags,
    } as LogsFlags)
  }

  it('lists known sources for the requested day', async () => {
    await fixtureDay(dataDir, '2026-05-06', {
      'tuwunel.log': 'tw line\n',
      'daemon.log': '{"msg":"d"}\n',
      'agent-docs.log': 'docs stderr\n',
      'agent-docs.acp.jsonl': '{"kind":"turn_started","agent":"docs","turn_id":"t1"}\n',
    })
    await symlink('2026-05-06', join(dataDir, 'logs', 'today'))
    await run({ source: undefined })
    const out = stdout.join('')
    expect(out).toContain('tuwunel')
    expect(out).toContain('daemon')
    expect(out).toContain('agent-docs')
  })

  it('reads a single source from today by default', async () => {
    await fixtureDay(dataDir, '2026-05-06', { 'tuwunel.log': 'hello tuwunel\n' })
    await symlink('2026-05-06', join(dataDir, 'logs', 'today'))
    await run({ source: 'tuwunel' })
    expect(stdout.join('')).toContain('hello tuwunel')
  })

  it('--day overrides the default (today)', async () => {
    await fixtureDay(dataDir, '2026-05-04', { 'tuwunel.log': 'old line\n' })
    await fixtureDay(dataDir, '2026-05-06', { 'tuwunel.log': 'new line\n' })
    await symlink('2026-05-06', join(dataDir, 'logs', 'today'))
    await run({ source: 'tuwunel', day: '2026-05-04' })
    const out = stdout.join('')
    expect(out).toContain('old line')
    expect(out).not.toContain('new line')
  })

  it('--turn filters JSONL events across all agent taps for that day', async () => {
    await fixtureDay(dataDir, '2026-05-06', {
      'agent-docs.acp.jsonl':
        [
          '{"kind":"turn_started","agent":"docs","turn_id":"t1"}',
          '{"kind":"session_update","agent":"docs","turn_id":"t1","notification":{"sessionUpdate":"tool_call"}}',
          '{"kind":"turn_completed","agent":"docs","turn_id":"t1","stop_reason":"end_turn"}',
          '{"kind":"turn_started","agent":"docs","turn_id":"t2"}',
        ].join('\n') + '\n',
      'agent-echo.acp.jsonl': '{"kind":"turn_started","agent":"echo","turn_id":"t1"}\n',
    })
    await symlink('2026-05-06', join(dataDir, 'logs', 'today'))
    await run({ turn: 't1' })
    const out = stdout.join('')
    expect(out).toContain('"turn_id":"t1"')
    expect(out).toContain('"agent":"docs"')
    expect(out).toContain('"agent":"echo"')
    expect(out).not.toContain('"turn_id":"t2"')
  })

  it('prune removes folders older than --keep, leaves today', async () => {
    await fixtureDay(dataDir, '2026-04-20', { 'x.log': '' })
    await fixtureDay(dataDir, '2026-05-01', { 'x.log': '' })
    await fixtureDay(dataDir, '2026-05-06', { 'x.log': '' })
    await symlink('2026-05-06', join(dataDir, 'logs', 'today'))
    await run({ subcommand: 'prune', keep: 3 })
    const remaining = (await readdir(join(dataDir, 'logs')))
      .filter((n) => n !== 'today')
      .sort()
    expect(remaining).toEqual(['2026-05-06'])
  })
})
