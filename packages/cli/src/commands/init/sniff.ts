import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findSimplePreset, PI_AUTH_FILE, PI_SETTINGS_FILE } from './registry.js'

export interface SniffResult {
  found: boolean
  /** Absolute path that satisfied the sniff (the config directory, or file for pi). */
  path?: string
}

/**
 * Checks whether the operator's per-CLI config directory (or, for pi, the
 * credential file) exists. NEVER reads any file inside — only `existsSync`.
 * One rule covers Linux, macOS Keychain, and OS keyring without per-backend
 * logic. The edge case where the dir exists but the operator isn't actually
 * logged in is accepted; the spawned shim will surface a clearer error on
 * first turn.
 *
 * `home` is overridable for tests.
 */
export function sniffCredentials(
  preset: 'claude' | 'codex' | 'pi',
  home: string = homedir(),
): SniffResult {
  // pi's credential is a file (auth.json), not a directory; existsSync covers
  // both, so the only difference is which relative path we join.
  const rel = preset === 'pi' ? PI_AUTH_FILE : findSimplePreset(preset)?.credentialDir
  if (!rel) return { found: false }
  const full = join(home, rel)
  if (existsSync(full)) return { found: true, path: full }
  return { found: false }
}

export interface PiDefaults {
  provider: string
  model: string
  /** Absolute path the pair came from, so the wizard can say where. */
  source: string
}

/**
 * Reads the operator's global pi defaults. A pair they already run
 * interactively is verified by use, which beats any pin this repo could guess.
 *
 * Returns undefined unless BOTH keys are present — half a pair cannot boot pi.
 * Never throws: a corrupt personal config must not abort onboarding.
 */
export function sniffPiDefaults(home: string = homedir()): PiDefaults | undefined {
  const source = join(home, PI_SETTINGS_FILE)
  try {
    const raw = JSON.parse(readFileSync(source, 'utf8')) as Record<string, unknown>
    const provider = raw.defaultProvider
    const model = raw.defaultModel
    if (typeof provider !== 'string' || !provider) return undefined
    if (typeof model !== 'string' || !model) return undefined
    return { provider, model, source }
  } catch {
    return undefined
  }
}
