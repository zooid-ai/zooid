import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildForwarderArgv } from './guest-forwarder.js'
import { SMOLVM_BIN, defaultVmExec, ensureVmMachine, stopVmMachine } from './vm-machine.js'

function smolvmAvailable(): boolean {
  try {
    execSync('smolvm --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!smolvmAvailable())('egress allowlist and socket mounts — real smolvm machine (ZOD128)', () => {
  const machine = `zooid-it-egress-${process.pid}`
  let root: string
  let sockDir: string
  let server: Server

  const guest = (script: string, timeout = '20s') =>
    defaultVmExec(SMOLVM_BIN, ['machine', 'exec', '--timeout', timeout, '--name', machine, '--', 'node', '-e', script])

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'zod128-it-'))
    const workdir = join(root, 'workdir')
    mkdirSync(workdir)
    // Short: Unix socket paths over 103 bytes are truncated.
    sockDir = mkdtempSync('/tmp/zi-')
    const sock = join(sockDir, 't.sock')
    server = createServer((_req, res) => res.end('ok'))
    await new Promise<void>((r) => server.listen(sock, () => r()))
    await ensureVmMachine({
      spec: {
        name: machine,
        image: 'node:22-alpine',
        workdir,
        cpus: 1,
        memoryMib: 1024,
        allowHosts: ['registry.npmjs.org'],
        sockets: [{ host: sock, guest: '/run/zooid/t.sock' }],
      },
      exec: defaultVmExec,
      stateFile: join(root, 'vm.json'),
      log: () => {},
    })
  }, 300_000)

  afterAll(async () => {
    await stopVmMachine(machine, defaultVmExec).catch(() => {})
    await defaultVmExec(SMOLVM_BIN, ['machine', 'delete', '--name', machine, '--force']).catch(() => {})
    await new Promise((r) => server?.close(r))
    rmSync(root, { recursive: true, force: true })
    rmSync(sockDir, { recursive: true, force: true })
  }, 120_000)

  it('reaches an allowed host', async () => {
    const r = await guest("fetch('https://registry.npmjs.org/-/ping').then(r=>console.log(r.status))")
    expect(r).toMatchObject({ stdout: '200\n' })
  }, 60_000)

  it('cannot reach any other host', async () => {
    const r = await guest(
      "fetch('https://example.com',{signal:AbortSignal.timeout(15000)}).then(r=>console.log('LEAK',r.status),e=>{console.log('blocked');process.exit(3)})",
    )
    expect(r.stdout).not.toContain('LEAK')
    expect(r.code).not.toBe(0)
  }, 60_000)

  it('reaches the host socket through the guest forwarder', async () => {
    const f = await defaultVmExec(SMOLVM_BIN, buildForwarderArgv(machine, 8787, '/run/zooid/t.sock'))
    expect(f.code).toBe(0)
    let out = ''
    for (let i = 0; i < 20 && out !== 'ok'; i++) {
      out = (await guest("fetch('http://127.0.0.1:8787/').then(r=>r.text()).then(t=>console.log(t),()=>console.log('down'))")).stdout.trim()
      if (out !== 'ok') await new Promise((r) => setTimeout(r, 250))
    }
    expect(out).toBe('ok')
  }, 60_000)

  it('a second forwarder start is harmless', async () => {
    const f = await defaultVmExec(SMOLVM_BIN, buildForwarderArgv(machine, 8787, '/run/zooid/t.sock'))
    expect(f.code).toBe(0)
    await new Promise((r) => setTimeout(r, 500))
    const r = await guest("fetch('http://127.0.0.1:8787/').then(r=>r.text()).then(t=>console.log(t))")
    expect(r.stdout.trim()).toBe('ok')
  }, 60_000)
})
