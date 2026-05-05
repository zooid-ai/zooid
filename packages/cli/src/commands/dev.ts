import chalk from 'chalk'
import { Listr } from 'listr2'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve, type ServerType } from '@hono/node-server'
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
import { startDaemon, type DaemonHandle } from '../daemon/start-daemon.js'
import { TuwunelService } from '../services/tuwunel.js'
import { resolveWebRoot } from '../web/resolve.js'
import { webStatic } from '../web/static.js'
import { buildShutdown } from './dev-cascade.js'

const CLI_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')

export interface DevFlags {
  cwd?: string
  dataDir: string
  hostPort?: number
  uiPort: number
  engine: 'docker' | 'podman'
  adminUser: string
  adminPassword: string
  installSignalHandlers?: boolean
  foreground?: boolean
}

export interface DevHandle {
  stop: () => Promise<void>
}

interface DevCtx {
  tokens?: Tokens
  svc?: TuwunelService
  daemon?: DaemonHandle
  uiServer?: ServerType
}

export async function runDev(flags: DevFlags): Promise<DevHandle> {
  const cwd = flags.cwd ?? process.cwd()
  const found = findConfigFile(cwd)
  if (!found) throw new Error(`workforce.yaml not found in ${cwd}`)
  // Use the unparsed text so that env-var expansion happens inside
  // loadWorkforceConfig once tokens are exported.
  const rawYaml = readFileSync(found.path, 'utf8')
  const preview = loadWorkforceConfig(rawYaml)
  const matrix = findMatrixTransport(preview)
  if (!matrix) {
    throw new Error('workforce.yaml: zooid dev requires at least one matrix transport')
  }
  const agentUserIds = Object.values(preview.agents)
    .filter((a) => a.transport === matrix.name && a.matrix_user_id)
    .map((a) => a.matrix_user_id!)
  const shape = deriveHomeserverShape(matrix.transport, agentUserIds)
  const port = flags.hostPort ?? shape.port
  const homeserver = `http://localhost:${port}`

  const dataDir = resolve(cwd, flags.dataDir)
  const paths = resolvePaths(dataDir)

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
            hostPort: port,
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
      {
        title: 'Start daemon',
        task: async () => {
          if (!ctx.tokens) throw new Error('tokens not ready')
          // Export tokens so loadWorkforceConfig's env interpolation can fill
          // the ${MATRIX_AS_TOKEN}/${MATRIX_HS_TOKEN} placeholders.
          process.env.MATRIX_AS_TOKEN = ctx.tokens.asToken
          process.env.MATRIX_HS_TOKEN = ctx.tokens.hsToken
          ctx.daemon = await startDaemon({
            configPath: found.path,
            cwd,
            installSignalHandlers: false,
          })
        },
      },
      {
        title: `Serve @zoon/web on http://localhost:${flags.uiPort}`,
        task: () => {
          const webRoot = resolveWebRoot(CLI_ROOT)
          const app = webStatic({ webRoot, homeserverUrl: homeserver })
          ctx.uiServer = serve({ fetch: app.fetch, port: flags.uiPort })
        },
      },
    ],
    { concurrent: false, exitOnError: true },
  )

  await tasks.run()

  const shutdown = buildShutdown({
    stopUi: async () => {
      const s = ctx.uiServer
      if (!s) return
      await new Promise<void>((r) => s.close(() => r()))
    },
    stopDaemon: async () => {
      await ctx.daemon?.stop()
    },
    stopTuwunel: async () => {
      await ctx.svc?.stop()
    },
  })

  if (flags.installSignalHandlers !== false) {
    const handler = async (): Promise<void> => {
      process.stdout.write(chalk.dim('\nStopping…\n'))
      await shutdown()
      process.exit(0)
    }
    process.on('SIGINT', () => void handler())
    process.on('SIGTERM', () => void handler())
  }

  process.stdout.write(
    [
      '',
      chalk.bold('Tuwunel is up.') + ` ${homeserver}`,
      chalk.bold('UI:        ') + ` http://localhost:${flags.uiPort}`,
      `  ${chalk.cyan('admin user:')} ${flags.adminUser} / ${flags.adminPassword}`,
      `  ${chalk.cyan('data dir:')} ${paths.dataDir}`,
      '',
      chalk.dim('Press Ctrl-C to stop.'),
      '',
    ].join('\n'),
  )

  if (flags.foreground !== false) {
    await ctx.daemon!.whenStopped
  }

  return { stop: shutdown }
}
