import dotenvExpand from 'dotenv-expand'

/**
 * Matches compose-style env references inside a value string:
 *   `${NAME}`, `$NAME`, `${NAME:-default}`, `${NAME-default}`,
 *   `${NAME:+alt}`, `${NAME+alt}`.
 *
 * The captured group is always the referenced variable name.
 */
const REF_RE =
  /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-+][^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g

export class EnvInterpolationError extends Error {}

const isDenied = (name: string): boolean =>
  name === 'ZOOID_TOKEN' || name.startsWith('ZOOID_')

/**
 * Run compose-style interpolation over a `{ KEY: literal-or-${ref} }` map.
 *
 * - Rejects keys in the `ZOOID_*` namespace.
 * - Rejects any `${ZOOID_*}` reference, including inside composed values
 *   (e.g. `"prefix-${ZOOID_INTERNAL}"`).
 * - Otherwise delegates to `dotenv-expand` for the actual substitution,
 *   preserving compose semantics (missing → empty string,
 *   `${VAR:-default}`, `${VAR-default}`, `$$` escape).
 */
export function interpolateEnv(
  parsed: Record<string, string>,
  processEnv: NodeJS.ProcessEnv,
  scope: string,
): Record<string, string> {
  for (const [key, val] of Object.entries(parsed)) {
    if (isDenied(key)) {
      throw new EnvInterpolationError(
        `${scope}.${key}: keys in the ZOOID_* namespace are not allowed`,
      )
    }
    if (typeof val !== 'string') {
      throw new EnvInterpolationError(
        `${scope}.${key}: env values must be strings (got ${typeof val})`,
      )
    }
    REF_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = REF_RE.exec(val)) !== null) {
      const ref = (m[1] ?? m[2]) as string
      if (isDenied(ref)) {
        throw new EnvInterpolationError(
          `${scope}.${key}: references to ZOOID_* vars are not allowed (saw \${${ref}})`,
        )
      }
    }
  }
  // Process each value through interpolateString. Per-key processing avoids
  // dotenv-expand's "processEnv shadows parsed" behaviour, which would let the
  // daemon's `LOG_LEVEL=debug` overwrite a literal `LOG_LEVEL: info` declared in
  // workforce.yaml. References still resolve against the full processEnv.
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(parsed)) {
    out[key] = interpolateString(val, processEnv)
  }
  return out
}

/**
 * Run compose-style interpolation over a single string value (e.g. a
 * transport's `as_token`). No denylist — transports legitimately reference
 * `ZOOID_*` tokens for the daemon itself (see [ZOD043] §Denylist note).
 */
export function interpolateString(
  value: string,
  processEnv: NodeJS.ProcessEnv,
): string {
  // Fast path: literals with no `$` need no expansion. Skipping the dotenv-expand
  // call also avoids the library's "processEnv shadows parsed" merge behaviour,
  // which can leak unrelated env vars through a sentinel key.
  if (!value.includes('$')) return value
  const sentinel = '__zooid_interp_v1__'
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(processEnv)) {
    if (typeof v === 'string') env[k] = v
  }
  delete env[sentinel]
  const result = dotenvExpand.expand({
    parsed: { [sentinel]: value },
    processEnv: env,
  })
  return result.parsed?.[sentinel] ?? ''
}
