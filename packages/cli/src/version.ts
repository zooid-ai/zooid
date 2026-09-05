import { readFileSync } from 'node:fs'

/**
 * The CLI's own version, read from the package manifest at startup.
 *
 * Never hardcode this. A literal goes stale on the very next release, and
 * `zooid --version` then lies about which build is installed — which is
 * exactly what it did from the first release through 0.12.0, where it
 * reported `0.0.1` forever.
 *
 * `dist/bin.js` (the published bundle) and `src/bin.ts` (a source run under
 * tsx) sit at the same depth relative to package.json, so a single
 * `../package.json` works for both without a build-time define.
 *
 * `url` is overridable for tests.
 */
export function readCliVersion(url: string = import.meta.url): string {
  try {
    const manifest = new URL('../package.json', url)
    const raw = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }
    if (typeof raw.version === 'string' && raw.version) return raw.version
    return 'unknown'
  } catch {
    // A missing or malformed manifest must never stop the CLI from running —
    // `--version` is the least important thing it does.
    return 'unknown'
  }
}

export const CLI_VERSION = readCliVersion()
