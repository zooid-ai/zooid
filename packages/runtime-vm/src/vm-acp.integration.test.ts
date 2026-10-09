import { execSync, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AcpAgentRegistry } from '@zooid/core'
import { VmAcpRuntime } from './vm-acp.js'
import { defaultVmExec, ensureVmMachine, stopVmMachine } from './vm-machine.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '..', 'test', 'fixtures', 'echo-workdir')

function smolvmAvailable(): boolean {
  try {
    execSync('smolvm --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function collect(child: ChildProcess): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    child.stdout!.on('data', (d) => (stdout += String(d)))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout }))
  })
}

describe.skipIf(!smolvmAvailable())('VmAcpRuntime — real smolvm machine', () => {
  const machine = `zooid-it-${process.pid}`
  let root: string
  let workdir: string

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'zod109-it-'))
    workdir = join(root, 'workdir')
    cpSync(FIXTURE, workdir, { recursive: true })
    writeFileSync(join(workdir, 'marker.txt'), 'hello-from-host')
    await ensureVmMachine({
      spec: { name: machine, image: 'node:22-alpine', workdir, cpus: 1, memoryMib: 1024 },
      exec: defaultVmExec,
      stateFile: join(root, 'vm.json'),
      log: () => {},
    })
  }, 300_000)

  afterAll(async () => {
    await stopVmMachine(machine, defaultVmExec).catch(() => {})
    await defaultVmExec('smolvm', ['machine', 'delete', '--name', machine, '--force']).catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }, 120_000)

  const rt = () => new VmAcpRuntime({ machine })

  it('the guest reads the host workdir at /workspace', async () => {
    const r = await collect(rt().spawn({ command: 'cat', args: ['marker.txt'], cwd: '/workspace' }))
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('hello-from-host')
  }, 60_000)

  it('the guest cannot write the workdir, even as root, and the host stays untouched', async () => {
    const r = await collect(
      rt().spawn({
        command: 'sh',
        args: ['-c', 'touch /workspace/leak || mount -o remount,rw /workspace && touch /workspace/leak'],
        cwd: '/',
      }),
    )
    expect(r.code).not.toBe(0)
    expect(existsSync(join(workdir, 'leak'))).toBe(false)
  }, 60_000)

  it('a host-side write into the workdir is visible in the guest (attachments)', async () => {
    writeFileSync(join(workdir, 'attachment.txt'), 'late file')
    const r = await collect(rt().spawn({ command: 'cat', args: ['/workspace/attachment.txt'] }))
    expect(r.stdout.trim()).toBe('late file')
  }, 60_000)

  it('passes env and cwd through the exec wrapper', async () => {
    const r = await collect(
      rt().spawn({ command: 'sh', args: ['-c', 'echo "$ZOOID_X:$(pwd)"'], env: { ZOOID_X: 'a b' }, cwd: '/tmp' }),
    )
    expect(r.stdout.trim()).toBe('a b:/tmp')
  }, 60_000)

  it('completes an ACP turn through AcpAgentRegistry', async () => {
    const registry = new AcpAgentRegistry({
      runtimeByAgent: { echo: rt() },
      agents: {
        echo: {
          name: 'echo',
          workdir,
          hooks: {},
          acp: { command: 'node', args: ['/workspace/echo-agent.mjs'] },
          approval_timeout_ms: 0,
          session_idle_timeout_ms: 0,
        },
      },
      cwd: { echo: '/workspace' },
    })
    const events: unknown[] = []
    registry.onEvent = (_name, event) => {
      events.push(event)
    }
    try {
      const result = await registry.prompt('echo', {
        threadId: 't1',
        content: [{ type: 'text', text: 'hello vm' }],
      })
      expect(result).toMatchObject({ stopReason: 'end_turn' })
      const seen = JSON.stringify(events)
      expect(seen).toContain('echo: hello vm')
      expect(seen).toContain('cwd /workspace')
      expect(seen).toContain('workdir read-only')
    } finally {
      await registry.stopAll()
    }
  }, 120_000)
})
