import { readFileSync } from 'node:fs'
import chalk from 'chalk'
import { findConfigFile, findMatrixTransport, loadWorkforceConfig } from '@zooid/core'
import { deriveHomeserverShape } from '../bootstrap/derive.js'

export interface StatusFlags {
  cwd?: string
  dataDir: string
  /** Tuwunel host port. If omitted, derived from workforce.yaml's matrix transport. */
  port?: number
}

export interface StatusReport {
  tuwunel: { status: 'up' | 'down'; url: string }
  daemon: { status: 'up' | 'down'; url: string } | { status: 'unknown'; reason: string }
  agents: { name: string; userId: string; trigger: string }[]
}

async function probe(url: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return r.status > 0
  } catch {
    return false
  }
}

export async function collectStatus(opts: {
  cwd: string
  tuwunelUrl: string
}): Promise<StatusReport> {
  const tuwunelUp = await probe(`${opts.tuwunelUrl}/_matrix/client/versions`)
  const tuwunel: StatusReport['tuwunel'] = {
    status: tuwunelUp ? 'up' : 'down',
    url: opts.tuwunelUrl,
  }

  const found = findConfigFile(opts.cwd)
  if (!found) {
    return {
      tuwunel,
      daemon: { status: 'unknown', reason: 'no workforce.yaml' },
      agents: [],
    }
  }
  const cfg = loadWorkforceConfig(readFileSync(found.path, 'utf8'))
  const matrixEntry = Object.entries(cfg.transports).find(
    ([, t]) => t.type === 'matrix',
  ) as [string, { port?: number }] | undefined
  const daemonPort = matrixEntry?.[1]?.port ?? 8080
  const daemonUrl = `http://localhost:${daemonPort}`
  const daemonUp = await probe(daemonUrl)
  const agents: StatusReport['agents'] = []
  for (const a of Object.values(cfg.agents)) {
    if (a.matrix_user_id) {
      agents.push({
        name: a.name,
        userId: a.matrix_user_id,
        trigger: a.trigger ?? 'mention',
      })
    }
  }
  return {
    tuwunel,
    daemon: { status: daemonUp ? 'up' : 'down', url: daemonUrl },
    agents,
  }
}

export async function runStatus(flags: StatusFlags): Promise<void> {
  const cwd = flags.cwd ?? process.cwd()
  let port = flags.port
  if (port === undefined) {
    const found = findConfigFile(cwd)
    if (found) {
      const cfg = loadWorkforceConfig(readFileSync(found.path, 'utf8'))
      const matrix = findMatrixTransport(cfg)
      if (matrix) {
        const userIds = Object.values(cfg.agents)
          .filter((a) => a.transport === matrix.name && a.matrix_user_id)
          .map((a) => a.matrix_user_id!)
        port = deriveHomeserverShape(matrix.transport, userIds).port
      }
    }
  }
  const tuwunelUrl = `http://localhost:${port ?? 8448}`
  const s = await collectStatus({ cwd, tuwunelUrl })
  const fmt = (st: 'up' | 'down' | 'unknown'): string =>
    st === 'up' ? chalk.green('up') : st === 'down' ? chalk.red('down') : chalk.yellow('unknown')
  process.stdout.write(
    [
      `tuwunel  ${fmt(s.tuwunel.status)}  ${s.tuwunel.url}`,
      `daemon   ${fmt(s.daemon.status)}  ${'url' in s.daemon ? s.daemon.url : s.daemon.reason}`,
      ...s.agents.map(
        (a) => `  agent: ${a.name} (${a.userId}, trigger: ${a.trigger})`,
      ),
      '',
    ].join('\n'),
  )
}
