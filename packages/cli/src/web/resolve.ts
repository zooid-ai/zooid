import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ENV_OVERRIDE = 'ZOOID_DEV_WEB_ROOT_OVERRIDE'

export function resolveWebRoot(cliRoot: string): string {
  const override = process.env[ENV_OVERRIDE]
  if (override && existsSync(join(override, 'index.html'))) return resolve(override)

  const published = join(cliRoot, 'dist', 'web')
  if (existsSync(join(published, 'index.html'))) return published

  const fromSource = webSourcePackage(cliRoot)
  if (fromSource && existsSync(join(fromSource, 'dist', 'index.html'))) {
    return join(fromSource, 'dist')
  }

  throw new Error(
    `@zoon/web build not found.\n  Tried: ${published}\n  Tried: ${fromSource ?? '(no monorepo source)'}\n` +
      `Run \`pnpm -C zoon/packages/web build\` (or set ${ENV_OVERRIDE} to a built dist).`,
  )
}

// Returns the path to the in-tree @zoon/web package (zoon/packages/web) if the
// CLI is running from the monorepo source. Returns null when running from an
// installed package (no sibling zoon/ tree).
export function webSourcePackage(cliRoot: string): string | null {
  const workspaceRoot = dirname(dirname(dirname(cliRoot)))
  const candidate = join(workspaceRoot, 'zoon', 'packages', 'web')
  return existsSync(join(candidate, 'package.json')) ? candidate : null
}
