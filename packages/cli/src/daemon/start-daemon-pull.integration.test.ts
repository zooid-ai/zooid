import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startDaemon } from './start-daemon.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zooid-pull-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Permissive stub: bootstrap CS calls all succeed with a benign body; the
// /sync endpoint returns one page (carrying next_batch `s-1`) then idles. The
// idle page is *paced* (~150ms) to mimic the long-poll — SyncLoop.run() has no
// inter-tick delay, so an instant stub would busy-loop. This proves the daemon
// selects + drives the pull loop; event→runTurn dispatch is covered in ZOD064.
function pullFetchStub() {
  let synced = false
  return vi.fn(async (input: string | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    if (url.pathname === '/_matrix/client/v3/sync') {
      if (synced) {
        await delay(150)
        return new Response(JSON.stringify({ next_batch: 's-idle', rooms: { join: {} } }), {
          status: 200,
        })
      }
      synced = true
      return new Response(JSON.stringify({ next_batch: 's-1', rooms: { join: {} } }), {
        status: 200,
      })
    }
    if (url.pathname.endsWith('/account/whoami')) {
      return new Response(JSON.stringify({ user_id: '@laptop:zoon.eco' }), { status: 200 })
    }
    // createRoom / register / join / send / state — benign shapes.
    if (url.pathname.endsWith('/createRoom')) {
      return new Response(JSON.stringify({ room_id: '!stub:zoon.eco' }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof globalThis.fetch
}

describe('startDaemon — matrix client (pull) mode', () => {
  it('binds no HTTP listener, runs the sync loop, persists a cursor, stops cleanly', async () => {
    const yamlPath = join(dir, 'zooid.yaml')
    writeFileSync(
      yamlPath,
      [
        'runtime: local',
        'workstation: laptop',
        'transports:',
        '  matrix:',
        '    homeserver: https://zoon.eco',
        '    mode: client',
        '    as_token: test-as-token',
        '    hs_token: test-hs-token',
        'agents:',
        '  docs:',
        '    workdir: .',
        '    acp: { preset: claude }',
        '    matrix:',
        '      transport: matrix',
        "      rooms: ['#general']",
      ].join('\n'),
    )

    const agentsDir = join(dir, 'data', 'agents')
    const handle = await startDaemon({
      configPath: yamlPath,
      installSignalHandlers: false,
      agentsDir,
      fetch: pullFetchStub(),
    })

    // (a) No inbound listener in pull mode.
    expect(handle.port).toBe(0)
    expect(handle.agentNames).toEqual(['docs'])

    // (c) Cursor persisted for the agent after a sync page is consumed, beside
    //     sessions.json under <agentsDir>/<agentName>/. run() ticks async.
    const sincePath = join(agentsDir, 'docs', 'sync-since')
    await vi.waitFor(() => expect(existsSync(sincePath)).toBe(true), {
      timeout: 3000,
      interval: 50,
    })

    // (b) Clean, idempotent shutdown stops the loop (no hanging long-poll).
    await handle.stop()
    await handle.stop()
  })
})
