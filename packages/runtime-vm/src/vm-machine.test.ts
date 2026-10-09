import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VM_GUEST_WORKDIR,
  buildCreateArgv,
  ensureVmMachine,
  findSecretFiles,
  stopVmMachine,
  vmMachineName,
  type VmExec,
  type VmMachineSpec,
} from './vm-machine.js'

// `machine ls --json` record shape as pinned by the Phase 0 spike.
type Rec = { name: string; state: string }

function fakeExec(machines: Rec[]) {
  const calls: string[][] = []
  const exec: VmExec = vi.fn(async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args])
    const [, sub] = args
    const name = args[args.indexOf('--name') + 1]
    if (sub === 'ls') return { code: 0, stdout: JSON.stringify(machines), stderr: '' }
    if (sub === 'create') machines.push({ name: name!, state: 'stopped' })
    if (sub === 'start') machines.find((m) => m.name === name)!.state = 'running'
    if (sub === 'stop') machines.find((m) => m.name === name)!.state = 'stopped'
    if (sub === 'delete') machines.splice(machines.findIndex((m) => m.name === name), 1)
    return { code: 0, stdout: '', stderr: '' }
  })
  return { exec, calls }
}

let dir: string
let workdir: string
let stateFile: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zod109-'))
  workdir = join(dir, 'agents', 'smoke')
  mkdirSync(workdir, { recursive: true })
  writeFileSync(join(workdir, 'AGENTS.md'), '# smoke')
  stateFile = join(dir, 'data', 'smoke', 'vm.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const spec = (over: Partial<VmMachineSpec> = {}): VmMachineSpec => ({
  name: 'zooid-smoke-abcd1234',
  image: 'node:22-alpine',
  workdir,
  cpus: 2,
  memoryMib: 2048,
  diskGib: 8,
  ...over,
})

describe('vmMachineName', () => {
  it('is stable per agent and config dir, and differs across workforces', () => {
    expect(vmMachineName('smoke', '/a')).toBe(vmMachineName('smoke', '/a'))
    expect(vmMachineName('smoke', '/a')).not.toBe(vmMachineName('smoke', '/b'))
    expect(vmMachineName('smoke', '/a')).toMatch(/^zooid-smoke-[0-9a-f]{8}$/)
  })
})

describe('buildCreateArgv', () => {
  it('mounts the workdir read-only at the guest workdir and never enables networking', () => {
    const argv = buildCreateArgv(spec())
    expect(argv).toEqual([
      'machine', 'create', '--name', 'zooid-smoke-abcd1234', '--image', 'node:22-alpine',
      '--cpus', '2', '--mem', '2048', '--storage', '8',
      '-v', `${workdir}:${VM_GUEST_WORKDIR}:ro`,
    ])
    expect(argv).not.toContain('--net')
    expect(argv.join(' ')).not.toMatch(/:staged/)
  })

  it('omits unset sizes so smolvm defaults apply', () => {
    expect(buildCreateArgv(spec({ cpus: undefined, memoryMib: undefined, diskGib: undefined }))).toEqual([
      'machine', 'create', '--name', 'zooid-smoke-abcd1234', '--image', 'node:22-alpine',
      '-v', `${workdir}:${VM_GUEST_WORKDIR}:ro`,
    ])
  })
})

describe('findSecretFiles', () => {
  it('finds .env*, .dev.vars* and .claude/settings.local.json, skipping node_modules and .git', () => {
    writeFileSync(join(workdir, '.env'), 'X=1')
    writeFileSync(join(workdir, '.env.local'), 'X=1')
    mkdirSync(join(workdir, 'sub'))
    writeFileSync(join(workdir, 'sub', '.dev.vars'), 'X=1')
    mkdirSync(join(workdir, '.claude'))
    writeFileSync(join(workdir, '.claude', 'settings.local.json'), '{}')
    writeFileSync(join(workdir, '.claude', 'settings.json'), '{}')
    mkdirSync(join(workdir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(workdir, 'node_modules', 'pkg', '.env'), 'X=1')
    expect(findSecretFiles(workdir)).toEqual([
      '.claude/settings.local.json',
      '.env',
      '.env.local',
      'sub/.dev.vars',
    ])
  })

  it('is empty for a config-only workdir', () => {
    expect(findSecretFiles(workdir)).toEqual([])
  })
})

describe('ensureVmMachine', () => {
  it('creates and starts a missing machine, then records its settings hash', async () => {
    const { exec, calls } = fakeExec([])
    await ensureVmMachine({ spec: spec(), exec, stateFile, log: () => {} })
    expect(calls.map((c) => c[2])).toEqual(['ls', 'create', 'start'])
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).machine).toBe('zooid-smoke-abcd1234')
  })

  it('only starts a stopped machine whose settings are unchanged', async () => {
    const m: Rec[] = []
    await ensureVmMachine({ spec: spec(), exec: fakeExec(m).exec, stateFile, log: () => {} })
    m[0]!.state = 'stopped'
    const { exec, calls } = fakeExec(m)
    await ensureVmMachine({ spec: spec(), exec, stateFile, log: () => {} })
    expect(calls.map((c) => c[2])).toEqual(['ls', 'start'])
  })

  it('does nothing to a running machine whose settings are unchanged', async () => {
    const m: Rec[] = []
    await ensureVmMachine({ spec: spec(), exec: fakeExec(m).exec, stateFile, log: () => {} })
    const { exec, calls } = fakeExec(m)
    await ensureVmMachine({ spec: spec(), exec, stateFile, log: () => {} })
    expect(calls.map((c) => c[2])).toEqual(['ls'])
  })

  it('recreates the machine when its settings change, and logs it', async () => {
    const m: Rec[] = []
    await ensureVmMachine({ spec: spec(), exec: fakeExec(m).exec, stateFile, log: () => {} })
    const { exec, calls } = fakeExec(m)
    const lines: string[] = []
    await ensureVmMachine({ spec: spec({ memoryMib: 4096 }), exec, stateFile, log: (l) => lines.push(l) })
    expect(calls.map((c) => c[2])).toEqual(['ls', 'stop', 'delete', 'create', 'start'])
    expect(lines.join('\n')).toMatch(/settings changed.*recreat/i)
    // Non-interactive delete needs --force (spike: it otherwise asks for confirmation).
    expect(calls.find((c) => c[2] === 'delete')).toContain('--force')
  })

  it('recreates a machine it has no record of (state file lost)', async () => {
    const { exec, calls } = fakeExec([{ name: 'zooid-smoke-abcd1234', state: 'stopped' }])
    await ensureVmMachine({ spec: spec(), exec, stateFile, log: () => {} })
    expect(calls.map((c) => c[2])).toEqual(['ls', 'delete', 'create', 'start'])
  })

  it('refuses a workdir holding secret files, before touching smolvm', async () => {
    writeFileSync(join(workdir, '.env'), 'TOKEN=x')
    const { exec, calls } = fakeExec([])
    await expect(ensureVmMachine({ spec: spec(), exec, stateFile, log: () => {} })).rejects.toThrow(
      new RegExp(`${workdir}.*\\.env`),
    )
    expect(calls).toEqual([])
    expect(existsSync(stateFile)).toBe(false)
  })

  it('surfaces smolvm stderr when a command fails', async () => {
    const exec: VmExec = async (_c, args) =>
      args[1] === 'ls'
        ? { code: 0, stdout: '[]', stderr: '' }
        : { code: 1, stdout: '', stderr: 'krun_add_virtiofs3 missing' }
    await expect(ensureVmMachine({ spec: spec(), exec, stateFile, log: () => {} })).rejects.toThrow(
      /machine create.*krun_add_virtiofs3 missing/s,
    )
  })
})

describe('stopVmMachine', () => {
  it('stops the machine and keeps its disk (no delete)', async () => {
    const { exec, calls } = fakeExec([{ name: 'n', state: 'running' }])
    await stopVmMachine('n', exec)
    expect(calls).toEqual([['smolvm', 'machine', 'stop', '--name', 'n']])
  })
})
