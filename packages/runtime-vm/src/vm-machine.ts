import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

/** Where the agent's workdir appears in the guest, and the ACP process's default cwd. */
export const VM_GUEST_WORKDIR = '/workspace'
export const SMOLVM_BIN = 'smolvm'

export interface VmExecResult {
  code: number
  stdout: string
  stderr: string
}
export type VmExec = (cmd: string, args: string[]) => Promise<VmExecResult>

export const defaultVmExec: VmExec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({
        code,
        stdout: String(stdout),
        stderr: String(stderr || (err && !stderr ? err.message : '')),
      })
    })
  })

export interface VmMachineSpec {
  /** smolvm machine name; see vmMachineName. */
  name: string
  image: string
  /** Absolute host path, mounted read-only at VM_GUEST_WORKDIR. */
  workdir: string
  cpus?: number
  memoryMib?: number
  diskGib?: number
}

/** One machine per agent per workforce: the config dir hash keeps two workforces on one host apart. */
export function vmMachineName(agentName: string, configDir: string): string {
  const h = createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  return `zooid-${agentName}-${h}`
}

/** Hash of everything fixed at create time. A change means the machine must be recreated. */
export function vmSpecHash(spec: VmMachineSpec): string {
  const { image, workdir, cpus, memoryMib, diskGib } = spec
  return createHash('sha256')
    .update(JSON.stringify({ image, workdir, cpus, memoryMib, diskGib }))
    .digest('hex')
    .slice(0, 16)
}

/**
 * The workdir is the only host path the guest gets, always `:ro` (smolvm
 * enforces it host-side, so a guest `remount,rw` doesn't help) and never
 * `:staged` (a write path back out). The mount shadows smolvm's own
 * `/workspace` on the storage disk. No `--net`: cycle-1 guests have no
 * network. [ZOD109]
 */
export function buildCreateArgv(spec: VmMachineSpec): string[] {
  const argv = ['machine', 'create', '--name', spec.name, '--image', spec.image]
  if (spec.cpus !== undefined) argv.push('--cpus', String(spec.cpus))
  if (spec.memoryMib !== undefined) argv.push('--mem', String(spec.memoryMib))
  if (spec.diskGib !== undefined) argv.push('--storage', String(spec.diskGib))
  argv.push('-v', `${spec.workdir}:${VM_GUEST_WORKDIR}:ro`)
  return argv
}

const SKIP_DIRS = new Set(['node_modules', '.git'])

function isSecret(rel: string): boolean {
  const base = rel.split('/').pop()!
  return (
    base.startsWith('.env') || base.startsWith('.dev.vars') || rel === '.claude/settings.local.json'
  )
}

/** Files a vm agent's workdir must not hold: the guest can read all of it. A backstop, not a scanner. */
export function findSecretFiles(workdir: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(abs)
      } else {
        const rel = relative(workdir, abs).split(sep).join('/')
        if (isSecret(rel)) found.push(rel)
      }
    }
  }
  walk(workdir)
  return found.sort()
}

interface MachineRecord {
  name: string
  running: boolean
}

/** `smolvm machine ls --json`: an array of records with `name` and `state` (smolvm 1.25). */
export function parseMachineList(stdout: string): MachineRecord[] {
  const raw = JSON.parse(stdout.trim() || '[]') as Array<Record<string, unknown>>
  return raw.map((r) => ({
    name: String(r.name),
    running: String(r.state ?? '').toLowerCase() === 'running',
  }))
}

async function run(exec: VmExec, args: string[]): Promise<VmExecResult> {
  const r = await exec(SMOLVM_BIN, args)
  if (r.code !== 0) {
    throw new Error(
      `smolvm ${args.slice(0, 2).join(' ')} failed (exit ${r.code}):\n${r.stderr.trim() || '(no stderr)'}`,
    )
  }
  return r
}

function readState(file: string): { machine: string; hash: string } | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

export interface EnsureVmMachineOptions {
  spec: VmMachineSpec
  exec: VmExec
  /** Where the machine's settings hash is kept between daemon runs. */
  stateFile: string
  log: (line: string) => void
}

/** Make the agent's machine exist with the current settings and be running. */
export async function ensureVmMachine({
  spec,
  exec,
  stateFile,
  log,
}: EnsureVmMachineOptions): Promise<void> {
  const secrets = findSecretFiles(spec.workdir)
  if (secrets.length > 0) {
    throw new Error(
      `vm agent workdir ${spec.workdir} holds secret files (${secrets.join(', ')}); ` +
        `the guest can read everything in it. Move credentials out of the workdir. See [ZOD109].`,
    )
  }
  const hash = vmSpecHash(spec)
  let rec = parseMachineList((await run(exec, ['machine', 'ls', '--json'])).stdout).find(
    (m) => m.name === spec.name,
  )
  if (rec && readState(stateFile)?.hash !== hash) {
    log(`[vm] ${spec.name}: vm settings changed — recreating the machine (its disk is discarded)`)
    if (rec.running) await run(exec, ['machine', 'stop', '--name', spec.name])
    // Non-interactive delete asks for confirmation unless forced.
    await run(exec, ['machine', 'delete', '--name', spec.name, '--force'])
    rec = undefined
  }
  if (!rec) {
    await run(exec, buildCreateArgv(spec))
    log(`[vm] ${spec.name}: created from ${spec.image}`)
  }
  if (!rec?.running) {
    await run(exec, ['machine', 'start', '--name', spec.name])
    log(`[vm] ${spec.name}: started`)
  }
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, JSON.stringify({ machine: spec.name, hash }))
}

/** Stop keeps the disk, which session/load needs across daemon restarts. */
export async function stopVmMachine(name: string, exec: VmExec): Promise<void> {
  await run(exec, ['machine', 'stop', '--name', name])
}
