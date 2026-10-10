import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

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
  /** Non-empty means `--net` plus one `--allow-host` each; otherwise no network. [ZOD128] */
  allowHosts?: string[]
  /** Host Unix sockets mounted into the guest. [ZOD128] */
  sockets?: VmSocketMount[]
  /** Local images only: changes when the archive is rebuilt, so the machine is recreated. */
  imageStamp?: string
}

export interface VmSocketMount {
  host: string
  guest: string
}

/** A path-like `vm.image` is a local `docker save` archive or rootfs dir; anything else is a registry reference. */
export function isLocalVmImage(image: string): boolean {
  return /^(\/|\.\/|\.\.\/|~\/)/.test(image)
}

/**
 * Resolve a local image to an absolute path plus a stamp that changes when it
 * is rebuilt. Registry references pass through untouched. [ZOD128]
 */
export function resolveVmImage(
  image: string,
  configDir: string,
  home: string,
): { image: string; stamp?: string } {
  if (!isLocalVmImage(image)) return { image }
  const path = image.startsWith('~/') ? join(home, image.slice(2)) : resolve(configDir, image)
  let st
  try {
    st = statSync(path)
  } catch {
    throw new Error(
      `vm image ${path} does not exist (from "${image}"). Build it first, e.g. local-workstation/images/build-agent-smoke`,
    )
  }
  const stamp = st.isDirectory() ? String(Math.trunc(st.mtimeMs)) : `${st.size}-${Math.trunc(st.mtimeMs)}`
  return { image: path, stamp }
}

/** One machine per agent per workforce: the config dir hash keeps two workforces on one host apart. */
export function vmMachineName(agentName: string, configDir: string): string {
  const h = createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  return `zooid-${agentName}-${h}`
}

/** Hash of everything fixed at create time. A change means the machine must be recreated. */
export function vmSpecHash(spec: VmMachineSpec): string {
  const { image, workdir, cpus, memoryMib, diskGib } = spec
  // New keys join only when set, so a cycle-1 spec hashes as before and its machine is kept.
  const input: Record<string, unknown> = { image, workdir, cpus, memoryMib, diskGib }
  if (spec.allowHosts?.length) input.allowHosts = [...spec.allowHosts].sort()
  if (spec.sockets?.length) {
    input.sockets = [...spec.sockets].sort((a, b) => a.guest.localeCompare(b.guest))
  }
  if (spec.imageStamp !== undefined) input.imageStamp = spec.imageStamp
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16)
}

/**
 * The workdir is the only host path the guest gets, always `:ro` (smolvm
 * enforces it host-side, so a guest `remount,rw` doesn't help) and never
 * `:staged` (a write path back out). The mount shadows smolvm's own
 * `/workspace` on the storage disk. The network is off unless the agent
 * lists `allow_hosts`, and then only those hosts resolve. [ZOD109] [ZOD128]
 */
export function buildCreateArgv(spec: VmMachineSpec): string[] {
  const argv = ['machine', 'create', '--name', spec.name, '--image', spec.image]
  if (spec.cpus !== undefined) argv.push('--cpus', String(spec.cpus))
  if (spec.memoryMib !== undefined) argv.push('--mem', String(spec.memoryMib))
  if (spec.diskGib !== undefined) argv.push('--storage', String(spec.diskGib))
  argv.push('-v', `${spec.workdir}:${VM_GUEST_WORKDIR}:ro`)
  if (spec.allowHosts?.length) {
    argv.push('--net')
    for (const h of spec.allowHosts) argv.push('--allow-host', h)
  }
  for (const s of spec.sockets ?? []) argv.push('--mount-socket', `${s.host}:${s.guest}`)
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
    if (spec.allowHosts?.length) await settle(exec, spec.name, log)
  }
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, JSON.stringify({ machine: spec.name, hash }))
}

const SETTLE_ATTEMPTS = 5

/**
 * smolvm 1.25.2 SIGKILLs whatever exec is in flight shortly after a networked
 * machine's first boot (exit 137 ~130ms into the first exec, whatever the
 * command). A fast `true` can finish first and leave the kill for the next
 * exec, so settle with one long enough to straddle it, retried until one
 * survives; the guest setup and the ACP process then never meet it.
 */
async function settle(exec: VmExec, name: string, log: (line: string) => void): Promise<void> {
  for (let i = 0; i < SETTLE_ATTEMPTS; i++) {
    const r = await exec(SMOLVM_BIN, ['machine', 'exec', '--name', name, '--', 'sleep', '1'])
    if (r.code === 0) return
    log(`[vm] ${name}: settling exec exited ${r.code}, retrying`)
  }
  throw new Error(`vm ${name} started but is not accepting commands (${SETTLE_ATTEMPTS} execs killed)`)
}

/** Stop keeps the disk, which session/load needs across daemon restarts. */
export async function stopVmMachine(name: string, exec: VmExec): Promise<void> {
  await run(exec, ['machine', 'stop', '--name', name])
}
