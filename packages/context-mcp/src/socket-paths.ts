import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** Maximum pathname bytes accepted by Unix-domain sockets, excluding its NUL. */
export const SUN_PATH_MAX = process.platform === 'darwin' ? 103 : 107

/** `context-` + twelve hex characters + `.sock`. */
const BASENAME_LEN = 25

/** Longest run directory which can hold one of this module's sockets. */
export const MAX_RUN_DIR = SUN_PATH_MAX - 1 - BASENAME_LEN

/**
 * Return a deterministic, fixed-width socket pathname for an agent.
 *
 * Hashing keeps arbitrary agent names out of the Unix socket path and leaves a
 * predictable amount of `sun_path` room for the daemon data directory.
 */
export function agentSocketPath(opts: { runDir: string; agentName: string }): string {
  if (opts.runDir.length > MAX_RUN_DIR) {
    throw new Error(
      `[context-mcp] run dir ${opts.runDir} (${opts.runDir.length} bytes) exceeds ` +
        `the ${MAX_RUN_DIR}-byte limit — unix socket paths cap at ${SUN_PATH_MAX + 1} bytes. ` +
        `Move the data dir closer to the filesystem root.`,
    )
  }
  const hash = createHash('sha256').update(opts.agentName).digest('hex').slice(0, 12)
  return join(opts.runDir, `context-${hash}.sock`)
}
