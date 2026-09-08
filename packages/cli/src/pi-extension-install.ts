import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface InstallPiExtensionResult {
  status: 'installed' | 'unchanged' | 'skipped'
  reason?: string
  target?: string
}

/** Install our bundle without replacing an operator's existing Pi extensions. */
export function installPiExtension(opts: {
  daemonHome: string
  bundlePath: string
}): InstallPiExtensionResult {
  const piHome = join(opts.daemonHome, '.pi')
  if (!existsSync(piHome)) return { status: 'skipped', reason: 'no Pi home' }
  const target = join(piHome, 'agent', 'extensions', 'zooid-tasks.js')
  mkdirSync(dirname(target), { recursive: true })
  const source = readFileSync(opts.bundlePath)
  if (existsSync(target) && readFileSync(target).equals(source)) return { status: 'unchanged', target }
  writeFileSync(target, source)
  return { status: 'installed', target }
}
