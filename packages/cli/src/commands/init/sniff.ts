import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findSimplePreset } from './registry.js'

export interface SniffResult {
  found: boolean
  /** Absolute path that satisfied the sniff (the config directory). */
  path?: string
}

/**
 * Checks whether the operator's per-CLI config directory exists. NEVER reads
 * any file inside — only `existsSync` on the dir. One rule covers Linux,
 * macOS Keychain, and OS keyring without per-backend logic. The edge case
 * where the dir exists but the operator isn't actually logged in is accepted;
 * the spawned shim will surface a clearer error on first turn.
 *
 * `home` is overridable for tests.
 */
export function sniffCredentials(
  preset: 'claude' | 'codex',
  home: string = homedir(),
): SniffResult {
  const meta = findSimplePreset(preset)
  if (!meta) return { found: false }
  const full = join(home, meta.credentialDir)
  if (existsSync(full)) return { found: true, path: full }
  return { found: false }
}
