import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ENV_OVERRIDE = 'ZOOID_DEV_WEB_ROOT_OVERRIDE'

export function resolveWebRoot(cliRoot: string): string {
  const override = process.env[ENV_OVERRIDE]
  if (override && existsSync(join(override, 'index.html'))) return resolve(override)

  const published = join(cliRoot, 'dist', 'web')
  if (existsSync(join(published, 'index.html'))) return published

  const workspaceRoot = dirname(dirname(dirname(cliRoot)))
  const fromSource = join(workspaceRoot, 'zoon', 'packages', 'web', 'dist')
  if (existsSync(join(fromSource, 'index.html'))) return fromSource

  throw new Error(
    `@zoon/web build not found.\n  Tried: ${published}\n  Tried: ${fromSource}\n` +
      `Run \`pnpm -C zoon/packages/web build\` (or set ${ENV_OVERRIDE} to a built dist).`,
  )
}
