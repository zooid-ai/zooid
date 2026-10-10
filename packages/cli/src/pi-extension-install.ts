import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { resolveAgentRuntime, type ZooidConfig } from '@zooid/core'

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

/**
 * Install the zooid-tasks extension for every pi agent. vm agents are
 * skipped: the extension dials the context socket, which a guest doesn't
 * have, and their agent dir lives in the guest anyway. [ZOD128]
 */
export function installPiExtensions(opts: {
  config: ZooidConfig
  configDir: string
  daemonHome: string
  env: { PI_CODING_AGENT_DIR?: string | undefined }
  /** A path, or a resolver called only when some agent needs it. */
  bundlePath: string | (() => string)
  log: (line: string) => void
}): void {
  const { config } = opts
  const piAgents = Object.keys(config.agents).filter(
    (name) => (config.agents[name]!.acp as { preset?: string } | undefined)?.preset === 'pi',
  )
  let bundlePath: string | undefined
  // PI_CODING_AGENT_DIR is normally relative, so each agent gets its own
  // extensions dir; an absolute value (or none) collapses them into one.
  const installed = new Set<string>()
  for (const name of piAgents) {
    if (resolveAgentRuntime(config.agents[name]!, config) === 'vm') {
      opts.log(`[pi] agent=${name} status=skipped reason=runtime-vm`)
      continue
    }
    const { dir, scope } = resolvePiAgentDir({
      agentWorkdir: resolve(opts.configDir, config.agents[name]!.workdir),
      daemonHome: opts.daemonHome,
      env: opts.env,
    })
    if (installed.has(dir)) continue
    installed.add(dir)
    bundlePath ??= typeof opts.bundlePath === 'function' ? opts.bundlePath() : opts.bundlePath
    const result = installPiExtension({ agentDir: dir, bundlePath, createMissing: scope === 'project' })
    const where = result.target ? ` extension=${result.target}` : ''
    const why = result.reason ? ` reason=${result.reason}` : ''
    opts.log(`[pi] agent=${name}${where} status=${result.status}${why}`)
  }
}
