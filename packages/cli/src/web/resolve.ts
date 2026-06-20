import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fetchWebBundle, type FetchWebBundleOptions } from './fetch.js'

const ENV_OVERRIDE = 'ZOOID_DEV_WEB_ROOT_OVERRIDE'

export interface EnsureWebRootOptions {
  cliRoot: string
  cacheDir: string
  version: string | undefined
  fetchBundle?: (opts: FetchWebBundleOptions) => Promise<string>
  onProgress?: (msg: string) => void
}

export async function ensureWebRoot(opts: EnsureWebRootOptions): Promise<string> {
  const override = process.env[ENV_OVERRIDE]
  if (override && existsSync(join(override, 'index.html'))) return resolve(override)

  const fromSource = webSourcePackage(opts.cliRoot)
  if (fromSource && existsSync(join(fromSource, 'dist', 'index.html'))) {
    return join(fromSource, 'dist')
  }

  if (!opts.version) {
    throw new Error(
      `No @zooid/web version pin (zooid.webVersion) in the cli package.json ` +
        `and no monorepo sibling build found.\n` +
        `Set ${ENV_OVERRIDE} to a built dist, or run from the monorepo.`,
    )
  }
  opts.onProgress?.(`Fetching @zooid/web ${opts.version}…`)
  const fetchBundleFn = opts.fetchBundle ?? fetchWebBundle
  return fetchBundleFn({ version: opts.version, cacheDir: opts.cacheDir })
}

// Returns the path to the in-tree @zooid/web package (zooid-clients/packages/web) if the
// CLI is running from the monorepo source. Returns null when running from an
// installed package (no sibling zooid-clients/ tree).
export function webSourcePackage(cliRoot: string): string | null {
  const workspaceRoot = dirname(dirname(dirname(cliRoot)))
  const candidate = join(workspaceRoot, 'zooid-clients', 'packages', 'web')
  return existsSync(join(candidate, 'package.json')) ? candidate : null
}
