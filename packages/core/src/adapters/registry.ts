import type { AgentAdapter } from '../types.js'

/**
 * Walks the provided adapters in order and returns the first one whose
 * isAvailable() check passes. Used by SessionRunner to detect which
 * agent CLI to drive.
 */
export function detectAdapter(
  adapters: AgentAdapter[],
  pathOverride?: string,
): AgentAdapter | null {
  for (const a of adapters) {
    if (a.isAvailable(pathOverride)) return a
  }
  return null
}
