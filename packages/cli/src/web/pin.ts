import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readZoonWebPin(cliRoot: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')) as {
      zooid?: { webVersion?: string }
    }
    return pkg.zooid?.webVersion
  } catch {
    return undefined
  }
}
