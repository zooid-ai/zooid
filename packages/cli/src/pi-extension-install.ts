import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface InstallPiExtensionResult {
  status: 'installed' | 'unchanged' | 'skipped'
  reason?: string
  target?: string
}

export interface PiAgentDir {
  dir: string
  /** `project` dirs are ours to create; `home` is the operator's ~/.pi. */
  scope: 'project' | 'home'
}

/**
 * Resolve pi's agent dir the way pi does: PI_CODING_AGENT_DIR when set,
 * otherwise ~/.pi/agent.  `zooid init` writes that variable as a *relative*
 * path on purpose (ZOD075) so one value is correct under both runtimes — it
 * resolves against the agent's cwd, and `agents/<name>` locally and
 * `/workspace` in a container are the same directory.  We always resolve
 * against the host workdir, which is the host side of that same mount.
 */
export function resolvePiAgentDir(opts: {
  agentWorkdir: string
  daemonHome: string
  env?: { PI_CODING_AGENT_DIR?: string | undefined }
}): PiAgentDir {
  const override = opts.env?.PI_CODING_AGENT_DIR
  if (override) {
    return {
      dir: isAbsolute(override) ? override : resolve(opts.agentWorkdir, override),
      scope: 'project',
    }
  }
  return { dir: join(opts.daemonHome, '.pi', 'agent'), scope: 'home' }
}

/** Install our bundle without replacing an operator's existing Pi extensions. */
export function installPiExtension(opts: {
  agentDir: string
  bundlePath: string
  /** Project dirs belong to the workspace, so we may create them. ~/.pi is the
   *  operator's: install into it only if they already use pi. */
  createMissing?: boolean
}): InstallPiExtensionResult {
  if (!opts.createMissing && !existsSync(opts.agentDir)) {
    return { status: 'skipped', reason: 'no Pi home' }
  }
  const target = join(opts.agentDir, 'extensions', 'zooid-tasks.js')
  mkdirSync(dirname(target), { recursive: true })
  const source = readFileSync(opts.bundlePath)
  if (existsSync(target) && readFileSync(target).equals(source)) return { status: 'unchanged', target }
  writeFileSync(target, source)
  return { status: 'installed', target }
}
