import { createRequire } from 'node:module'

/** Location of the self-contained extension installed by the Zooid daemon. */
export function resolvePiExtensionBundle(): string {
  return createRequire(import.meta.url).resolve('@zooid/pi-extension/bundle')
}
