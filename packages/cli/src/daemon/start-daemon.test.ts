import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startDaemon } from './start-daemon.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zooid-startd-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('startDaemon — http transport (smoke without Matrix)', () => {
  it('starts an http transport when workforce.yaml only declares one', async () => {
    const yamlPath = join(dir, 'workforce.yaml')
    writeFileSync(
      yamlPath,
      [
        'runtime: local',
        'transports:',
        '  http-local:',
        '    type: http',
        '    port: 0',
        'agents:',
        '  noop:',
        '    transport: http-local',
        '    workdir: .',
        '    acp: { preset: claude }',
      ].join('\n'),
    )
    process.env.ZOOID_TOKEN = 'test-token'

    const handle = await startDaemon({
      configPath: yamlPath,
      installSignalHandlers: false,
    })

    expect(handle.port).toBeGreaterThan(0)
    expect(handle.agentNames).toEqual(['noop'])

    const r = await fetch(`http://localhost:${handle.port}/`, {
      headers: { authorization: 'Bearer test-token' },
    })
    expect(r.status).toBeGreaterThan(0)

    await handle.stop()
    await handle.stop()
  })

  it('rejects when no transport is declared', async () => {
    const yamlPath = join(dir, 'workforce.yaml')
    writeFileSync(
      yamlPath,
      [
        'runtime: local',
        'agents:',
        '  a:',
        '    transport: x',
        '    workdir: .',
        '    acp: { preset: claude }',
      ].join('\n'),
    )
    await expect(
      startDaemon({ configPath: yamlPath, installSignalHandlers: false }),
    ).rejects.toThrow()
  })
})
