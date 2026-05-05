import { randomBytes } from 'node:crypto'
import type { CliFlags } from '@zooid/core'
import { startDaemon } from '../daemon/start-daemon.js'

export interface StartFlags extends CliFlags {
  printToken?: boolean
}

export async function runStart(flags: StartFlags): Promise<void> {
  if (flags.printToken) {
    process.stdout.write(`${randomBytes(32).toString('hex')}\n`)
    return
  }
  const handle = await startDaemon({ cliFlags: flags, installSignalHandlers: true })
  console.log(`zooid listening on http://localhost:${handle.port}`)
  for (const name of handle.agentNames) console.log(`  agent: ${name}`)
  await handle.whenStopped
}
