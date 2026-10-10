import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VM_GUEST_WORKDIR,
  buildCreateArgv,
  ensureVmMachine,
  findSecretFiles,
  isLocalVmImage,
  resolveVmImage,
  stopVmMachine,
  vmMachineName,
  vmSpecHash,
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

describe('buildCreateArgv — network and sockets (ZOD128)', () => {
  const tail = (a: string[]) => a.slice(a.indexOf('-v'))

  it('a cycle-1 spec still gets no network and no sockets', () => {
    const argv = buildCreateArgv(spec())
    expect(argv).not.toContain('--net')
    expect(argv).not.toContain('--allow-host')
    expect(argv).not.toContain('--mount-socket')
  })

  it('allowHosts enables the network with one --allow-host each, in config order', () => {
    expect(tail(buildCreateArgv(spec({ allowHosts: ['github.com', 'ghcr.io'] })))).toEqual([
      '-v', `${workdir}:${VM_GUEST_WORKDIR}:ro`,
      '--net', '--allow-host', 'github.com', '--allow-host', 'ghcr.io',
    ])
  })

  it('an empty allowHosts is no network', () => {
    expect(buildCreateArgv(spec({ allowHosts: [] }))).not.toContain('--net')
  })

  it('mounts each socket after any --allow-host', () => {
    expect(
      tail(
        buildCreateArgv(
          spec({
            allowHosts: ['github.com'],
            sockets: [{ host: '/t/a.sock', guest: '/run/zooid/model.sock' }],
          }),
        ),
      ),
    ).toEqual([
      '-v', `${workdir}:${VM_GUEST_WORKDIR}:ro`,
      '--net', '--allow-host', 'github.com',
      '--mount-socket', '/t/a.sock:/run/zooid/model.sock',
    ])
  })
})

describe('vmSpecHash (ZOD128)', () => {
  const base: VmMachineSpec = {
    name: 'n', image: 'node:22-alpine', workdir: '/w', cpus: 2, memoryMib: 2048, diskGib: 8,
  }

  it('hashes a cycle-1 spec exactly as cycle 1 did, so existing machines are kept', () => {
    // Pinned from cycle 1's formula before it changed.
    expect(vmSpecHash(base)).toBe('80b24681ac5e4920')
    expect(vmSpecHash({ ...base, allowHosts: [], sockets: [] })).toBe('80b24681ac5e4920')
  })

  it('ignores host order', () => {
    expect(vmSpecHash({ ...base, allowHosts: ['a.io', 'b.io'] })).toBe(
      vmSpecHash({ ...base, allowHosts: ['b.io', 'a.io'] }),
    )
  })

  it('changes when hosts are added', () => {
    expect(vmSpecHash({ ...base, allowHosts: ['a.io'] })).not.toBe(vmSpecHash(base))
  })

  it('changes when a socket is added', () => {
    expect(vmSpecHash({ ...base, sockets: [{ host: '/h', guest: '/g' }] })).not.toBe(vmSpecHash(base))
  })

  it('changes with the image stamp', () => {
    expect(vmSpecHash({ ...base, imageStamp: '1-2' })).not.toBe(vmSpecHash({ ...base, imageStamp: '1-3' }))
    expect(vmSpecHash({ ...base, imageStamp: '1-2' })).not.toBe(vmSpecHash(base))
  })
})

describe('local vm images (ZOD128)', () => {
  it('treats path-like images as local and everything else as a registry reference', () => {
    for (const i of ['/a.tar', './a.tar', '../a.tar', '~/a.tar']) expect(isLocalVmImage(i)).toBe(true)
    for (const i of ['alpine', 'ghcr.io/x/y:1', 'localhost:5000/x']) expect(isLocalVmImage(i)).toBe(false)
  })

  it('leaves a registry reference untouched, with no stamp', () => {
    expect(resolveVmImage('ghcr.io/x/y:1', '/nonexistent', '/nonexistent')).toEqual({ image: 'ghcr.io/x/y:1' })
  })

  it('expands ~/ against home and ./ against the config dir, stamping size and mtime', () => {
    const home = join(dir, 'home')
    const cd = join(dir, 'cfg')
    mkdirSync(join(home, 'i'), { recursive: true })
    mkdirSync(cd, { recursive: true })
    writeFileSync(join(home, 'i', 'a.tar'), 'abc')
    writeFileSync(join(cd, 'b.tar'), 'abcdef')
    const a = resolveVmImage('~/i/a.tar', cd, home)
    const st = statSync(join(home, 'i', 'a.tar'))
    expect(a).toEqual({ image: join(home, 'i', 'a.tar'), stamp: `3-${Math.trunc(st.mtimeMs)}` })
    const b = resolveVmImage('./b.tar', cd, home)
    expect(b.image).toBe(join(cd, 'b.tar'))
    expect(b.stamp).toMatch(/^6-\d+$/)
  })

  it('a new mtime gives a new stamp', () => {
    const f = join(dir, 'img.tar')
    writeFileSync(f, 'x')
    utimesSync(f, 1000, 1000)
    const before = resolveVmImage(f, dir, dir).stamp
    utimesSync(f, 2000, 2000)
    expect(resolveVmImage(f, dir, dir).stamp).not.toBe(before)
  })

  it('refuses a missing local image, naming the resolved path', () => {
    const home = join(dir, 'home')
    expect(() => resolveVmImage('~/nope.tar', dir, home)).toThrow(
      `vm image ${join(home, 'nope.tar')} does not exist (from "~/nope.tar"). Build it first, e.g. local-workstation/images/build-agent-smoke`,
    )
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

  it('settles a networked machine after starting it, retrying the exec smolvm kills', async () => {
    // smolvm 1.25.2 SIGKILLs an exec in flight just after a networked
    // machine's first boot (exit 137). A throwaway `sleep 1` absorbs it.
    const machines: Rec[] = []
    const calls: string[][] = []
    let kills = 1
    const exec: VmExec = async (_c, args) => {
      calls.push(args)
      const r = await fakeExec(machines).exec('smolvm', args)
      if (args[1] === 'exec' && kills-- > 0) return { code: 137, stdout: '', stderr: '' }
      return r
    }
    await ensureVmMachine({ spec: spec({ allowHosts: ['github.com'] }), exec, stateFile, log: () => {} })
    expect(calls.map((c) => c[1])).toEqual(['ls', 'create', 'start', 'exec', 'exec'])
    expect(calls.at(-1)).toEqual(['machine', 'exec', '--name', 'zooid-smoke-abcd1234', '--', 'sleep', '1'])
  })

  it('does not settle a machine that was already running', async () => {
    const m: Rec[] = []
    const s = spec({ allowHosts: ['github.com'] })
    await ensureVmMachine({ spec: s, exec: fakeExec(m).exec, stateFile, log: () => {} })
    const { exec, calls } = fakeExec(m)
    await ensureVmMachine({ spec: s, exec, stateFile, log: () => {} })
    expect(calls.map((c) => c[2])).toEqual(['ls'])
  })

  it('gives up settling after repeated kills, naming the machine', async () => {
    const m: Rec[] = []
    const exec: VmExec = async (_c, args) =>
      args[1] === 'exec' ? { code: 137, stdout: '', stderr: '' } : fakeExec(m).exec('smolvm', args)
    await expect(
      ensureVmMachine({ spec: spec({ allowHosts: ['github.com'] }), exec, stateFile, log: () => {} }),
    ).rejects.toThrow(/zooid-smoke-abcd1234.*not accepting commands/)
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
