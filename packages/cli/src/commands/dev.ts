import chalk from 'chalk'
import { Listr } from 'listr2'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  findConfigFile,
  findMatrixTransport,
  loadWorkforceConfig,
} from '@zooid/core'
import { ensureAdminUser } from '../bootstrap/admin.js'
import { writeBootstrapConfigs } from '../bootstrap/configs.js'
import { deriveHomeserverShape } from '../bootstrap/derive.js'
import { resolvePaths } from '../bootstrap/paths.js'
import { ensureTokens, type Tokens } from '../bootstrap/tokens.js'
import { TuwunelService } from '../services/tuwunel.js'

export interface DevFlags {
  dataDir: string
  engine: 'docker' | 'podman'
  adminUser: string
  adminPassword: string
}

interface DevCtx {
  tokens?: Tokens
  svc?: TuwunelService
}

export async function runDev(flags: DevFlags): Promise<void> {
  const found = findConfigFile(process.cwd())
  if (!found) {
    throw new Error('workforce.yaml is required in the current directory')
  }
  const config = loadWorkforceConfig(readFileSync(found.path, 'utf8'))
  const matrix = findMatrixTransport(config)
  if (!matrix) {
    throw new Error(
      'workforce.yaml: zooid dev requires at least one transport with type: matrix',
    )
  }
  const agentUserIds = Object.values(config.agents)
    .filter((a) => a.transport === matrix.name && a.matrix_user_id)
    .map((a) => a.matrix_user_id!)
  const shape = deriveHomeserverShape(matrix.transport, agentUserIds)

  const dataDir = resolve(flags.dataDir)
  const paths = resolvePaths(dataDir)
  const homeserver = `http://localhost:${shape.port}`

  const ctx: DevCtx = {}

  const tasks = new Listr<DevCtx>(
    [
      {
        title: 'Generate AS tokens',
        task: () => {
          ctx.tokens = ensureTokens(paths.envPath)
        },
      },
      {
        title: 'Write tuwunel.toml + appservice.yaml',
        task: () => {
          if (!ctx.tokens) throw new Error('tokens not ready')
          writeBootstrapConfigs({
            paths,
            serverName: shape.serverName,
            asToken: ctx.tokens.asToken,
            hsToken: ctx.tokens.hsToken,
            senderLocalpart: matrix.transport.sender_localpart,
            userNamespace: matrix.transport.user_namespace,
          })
        },
      },
      {
        title: `Start Tuwunel container (${flags.engine})`,
        task: async () => {
          ctx.svc = new TuwunelService({
            name: 'zooid-tuwunel',
            hostPort: shape.port,
            paths,
            engine: flags.engine,
          })
          await ctx.svc.start()
        },
      },
      {
        title: 'Wait for Tuwunel /_matrix/client/versions',
        task: async () => {
          if (!ctx.svc) throw new Error('service not started')
          await ctx.svc.waitHealthy({ url: homeserver, timeoutMs: 60_000 })
        },
      },
      {
        title: `Register admin user @${flags.adminUser}:${shape.serverName}`,
        task: async (_, t) => {
          const r = await ensureAdminUser({
            homeserver,
            username: flags.adminUser,
            password: flags.adminPassword,
          })
          t.title = r.created
            ? `Registered admin: ${r.userId}`
            : `Admin already exists: ${r.userId}`
        },
      },
    ],
    { concurrent: false, exitOnError: true },
  )

  await tasks.run()

  process.stdout.write(
    [
      '',
      chalk.bold('Tuwunel is up.') + ` ${homeserver}`,
      `  ${chalk.cyan('admin user:')} ${flags.adminUser} / ${flags.adminPassword}`,
      `  ${chalk.cyan('data dir:')} ${paths.dataDir}`,
      '',
      chalk.dim('Press Ctrl-C to stop.'),
      '',
    ].join('\n'),
  )

  // A pending Promise alone doesn't keep Node's event loop alive — there
  // must be an I/O or timer reference. setInterval is the cheapest one.
  // Cycle 2 will replace this with the daemon process which keeps the
  // loop busy on its own.
  const keepalive = setInterval(() => {}, 1 << 30)

  const shutdown = async () => {
    clearInterval(keepalive)
    process.stdout.write(chalk.dim('\nStopping Tuwunel...\n'))
    await ctx.svc?.stop().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
