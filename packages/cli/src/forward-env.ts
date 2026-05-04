/**
 * Resolve a single agent's `docker.forward_env` list to a concrete map of
 * env vars to feed into the container. Mirrors the legacy resolver in
 * `runtime-docker/src/env.ts` but operates without an adapter context —
 * the new ACP world has no adapter-declared `envPassthrough` list.
 *
 * Rules:
 *   - "NAME"           — pass-through same-name from process.env
 *   - "HOST:CONTAINER" — read process.env[HOST], expose as CONTAINER
 *   - ZOOID_TOKEN and any ZOOID_* are blocked unconditionally on either side
 *   - Missing source vars are silently dropped
 *   - Last entry wins on container-side name collision
 */

const DENY = (name: string): boolean =>
  name === 'ZOOID_TOKEN' || name.startsWith('ZOOID_')

interface EnvSpec {
  from: string
  to: string
}

function parseEntry(raw: string): EnvSpec {
  const idx = raw.indexOf(':')
  if (idx === -1) return { from: raw, to: raw }
  return { from: raw.slice(0, idx), to: raw.slice(idx + 1) }
}

export function resolveForwardEnv(
  forwardEnv: string[] | undefined,
  processEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of forwardEnv ?? []) {
    const { from, to } = parseEntry(raw)
    if (DENY(from) || DENY(to)) continue
    const value = processEnv[from]
    if (value === undefined) continue
    out[to] = value
  }
  return out
}
