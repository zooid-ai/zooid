import type { AgentAdapter } from '@zooid/core'

interface EnvSpec {
  /** Name to look up in the daemon's process.env. */
  from: string
  /** Name to set inside the container. Equal to `from` for pass-through. */
  to: string
}

function parseForwardEnvEntry(raw: string): EnvSpec {
  const idx = raw.indexOf(':')
  if (idx === -1) return { from: raw, to: raw }
  // Parser already rejected empty halves and >2 parts; this just types them.
  return { from: raw.slice(0, idx), to: raw.slice(idx + 1) }
}

const DENY = (name: string): boolean =>
  name === 'ZOOID_TOKEN' || name.startsWith('ZOOID_')

/**
 * Resolve the full set of env vars to forward into a session container.
 *
 * Inputs:
 *   - adapter.envPassthrough: same-name vars the adapter's CLI needs.
 *   - agentForwardEnv:        user-declared additions from `docker.forward_env`.
 *                             Plain `"FOO"` is pass-through; `"HOST:CONTAINER"`
 *                             reads from process.env[HOST] and exposes as CONTAINER.
 *   - processEnv:             the daemon process's env. Missing source vars are
 *                             silently dropped (persona portability).
 *
 * Invariants:
 *   1. ZOOID_TOKEN and anything matching ZOOID_* is NEVER forwarded, regardless
 *      of which side of a rename it appears on. Preserves the deploy-dind-multi-agent
 *      §7 contract.
 *   2. Dedup is by container-side name. Last wins (user's forward_env runs after
 *      the adapter's declared list, so a user can shadow an adapter passthrough
 *      if they explicitly want to).
 *   3. Output is sorted alphabetically by container-side name for deterministic argv.
 */
export function resolveEnvPassthrough(
  adapter: AgentAdapter,
  agentForwardEnv: string[] | undefined,
  processEnv: Record<string, string | undefined>,
): Array<[string, string]> {
  const specs: EnvSpec[] = [
    ...(adapter.envPassthrough ?? []).map((n) => ({ from: n, to: n })),
    ...(agentForwardEnv ?? []).map(parseForwardEnvEntry),
  ]
  const byTarget = new Map<string, [string, string]>()
  for (const { from, to } of specs) {
    if (DENY(from) || DENY(to)) continue
    const value = processEnv[from]
    if (value === undefined) continue
    byTarget.set(to, [to, value])
  }
  return [...byTarget.values()].sort(([a], [b]) => a.localeCompare(b))
}
