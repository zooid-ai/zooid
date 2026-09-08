import { pathToFileURL } from 'node:url'
import type { TriggerConfig } from '@zooid/core'
import type { CustomVerifier } from './webhook-verify.js'

/**
 * Import the `verify:` module of every `provider: custom` trigger, keyed by
 * trigger name.
 *
 * Loaded once at daemon start rather than per delivery: a bad path or a
 * module that exports the wrong thing is a configuration error, and it
 * should surface when the operator starts the daemon, not silently as a 401
 * the first time the service fires. Config has already resolved the path to
 * an absolute one against the zooid.yaml directory.
 */
export async function loadCustomVerifiers(
  triggers: Record<string, TriggerConfig>,
): Promise<Record<string, CustomVerifier>> {
  const out: Record<string, CustomVerifier> = {}
  for (const [name, trigger] of Object.entries(triggers)) {
    const path = trigger.webhook?.provider === 'custom' ? trigger.webhook.verify : undefined
    if (!path) continue

    let mod: Record<string, unknown>
    try {
      mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>
    } catch (err) {
      throw new Error(
        `triggers.${name}.webhook.verify: cannot load ${path} — ${(err as Error).message}`,
      )
    }
    // `export default` is the documented shape; a named `verify` export is
    // accepted so a module can hold more than one provider's verifier.
    const fn = mod.default ?? mod.verify
    if (typeof fn !== 'function') {
      throw new Error(
        `triggers.${name}.webhook.verify: ${path} must export a function as \`default\` ` +
          `(or as \`verify\`), got ${typeof fn}`,
      )
    }
    out[name] = fn as CustomVerifier
  }
  return out
}
