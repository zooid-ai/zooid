import chalk from 'chalk'
import { readFileSync } from 'node:fs'
import {
  findConfigFile,
  findMatrixTransport,
  loadWorkforceConfig,
} from '@zooid/core'
import { deriveHomeserverShape } from '../bootstrap/derive.js'

export interface StatusFlags {
  dataDir: string
}

export async function runStatus(flags: StatusFlags): Promise<void> {
  const found = findConfigFile(process.cwd())
  if (!found) {
    process.stdout.write('workforce.yaml not found in cwd\n')
    process.exit(1)
  }
  const config = loadWorkforceConfig(readFileSync(found.path, 'utf8'))
  const matrix = findMatrixTransport(config)
  if (!matrix) {
    process.stdout.write('no matrix transport in workforce.yaml\n')
    process.exit(1)
  }
  const agentUserIds = Object.values(config.agents)
    .filter((a) => a.transport === matrix.name && a.matrix_user_id)
    .map((a) => a.matrix_user_id!)
  const shape = deriveHomeserverShape(matrix.transport, agentUserIds)
  const homeserver = `http://localhost:${shape.port}`

  let tuwunel = chalk.red('down')
  try {
    const r = await fetch(`${homeserver}/_matrix/client/versions`, {
      signal: AbortSignal.timeout(2_000),
    })
    if (r.ok) tuwunel = chalk.green('up')
  } catch {
    // remains down
  }
  process.stdout.write(
    [`tuwunel  ${tuwunel}  ${homeserver}`, `data     ${flags.dataDir}`, ''].join(
      '\n',
    ),
  )
}
