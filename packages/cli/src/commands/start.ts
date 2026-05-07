import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { CliFlags } from '@zooid/core'
import { resolveDataLayout } from '../bootstrap/data-layout.js'
import { startDaemon } from '../daemon/start-daemon.js'

export interface StartFlags extends CliFlags {
  printToken?: boolean
  /** Data root dir; defaults to `./data` relative to cwd. */
  dataDir?: string
}

export async function runStart(flags: StartFlags): Promise<void> {
  if (flags.printToken) {
    process.stdout.write(`${randomBytes(32).toString('hex')}\n`)
    return
  }
  const dataRoot = resolve(process.cwd(), flags.dataDir ?? './data')
  const layout = resolveDataLayout(dataRoot)
  const handle = await startDaemon({
    cliFlags: flags,
    installSignalHandlers: true,
    agentsDir: layout.agentsDir,
  })
  console.log(`zooid listening on http://localhost:${handle.port}`)
  for (const name of handle.agentNames) console.log(`  agent: ${name}`)
  await handle.whenStopped
}
