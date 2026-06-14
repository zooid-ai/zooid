import chalk from 'chalk'
import { Listr } from 'listr2'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve, type ServerType } from '@hono/node-server'
import {
  findConfigFile,
  findMatrixTransport,
  loadZooidConfig,
} from '@zooid/core'
import { ensureAdminUser } from '../bootstrap/admin.js'
import { writeBootstrapConfigs } from '../bootstrap/configs.js'
import { resolveDataLayout } from '../bootstrap/data-layout.js'
import { deriveHomeserverShape } from '../bootstrap/derive.js'
import { resolvePaths } from '../bootstrap/paths.js'
import { ensureTokens, type Tokens } from '../bootstrap/tokens.js'
import { startDaemon, type DaemonHandle } from '../daemon/start-daemon.js'
import { TuwunelService } from '../services/tuwunel.js'
import { ensureWebRoot, webSourcePackage } from '../web/resolve.js'
import { readZoonWebPin } from '../web/pin.js'
import { webStatic } from '../web/static.js'
import { startWebWatch, type WebWatchHandle } from '../web/watch.js'
import {
  ensureDayFolder,
  pruneOldDays,
  resolveLogPaths,
  type LogPaths,
} from '../observability/paths.js'
import {
  wireAgentCapture,
  type AgentCapture,
} from '../observability/capture-agent.js'
import { captureChildToFile } from '../observability/capture-tuwunel.js'
import { buildShutdown } from './dev-cascade.js'

// Walk up from this module until we find the @zooid/cli package.json. This
// is robust to the source/bundle distinction: src/commands/dev.ts and
// dist/bin.js end up at different depths, so a fixed `..` count breaks
// after `tsup`. The package's "name" field disambiguates from any parent.
const CLI_ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    const pkgPath = resolve(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string }
        if (pkg.name === 'zooid' || pkg.name === '@zooid/cli') return dir
      } catch {
        // ignore
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('cli root not found (no @zooid/cli package.json above ' + import.meta.url + ')')
})()

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
  // Run `vite build --watch` against a @zooid/web package and serve its dist.
  // true = auto-detect (sibling ../zooid-clients/packages/web or in-monorepo); string = explicit path.
  watchWeb?: string | boolean
}

export interface DevHandle {
  stop: () => Promise<void>
}

interface DevCtx {
  tokens?: Tokens
  svc?: TuwunelService
  daemon?: DaemonHandle
  uiServer?: ServerType
  webWatch?: WebWatchHandle
  logPaths?: LogPaths
  captures?: Record<string, AgentCapture>
  tuwunelCaptureDone?: Promise<void>
}

export async function runDev(flags: DevFlags): Promise<DevHandle> {
  const cwd = flags.cwd ?? process.cwd()
  const found = findConfigFile(cwd)
  if (!found) throw new Error(`zooid.yaml not found in ${cwd}`)
  // Load .env files from the workforce dir before anything reads process.env.
  // Order matches the convention used by Vite/Next: .env.local overrides .env,
  // and real shell vars override both (loadEnvFile never overwrites existing
  // process.env entries). Spawned agents inherit these via runtime-local.
  loadEnvFiles(cwd)

  // Resolve data paths up front — they only depend on cwd/flags, not the
  // parsed config — so we can ensure tokens before any loadZooidConfig call.
  const dataRoot = resolve(cwd, flags.dataDir)
  const layout = resolveDataLayout(dataRoot)
  const paths = resolvePaths(layout.matrixDir)
  const logPaths = resolveLogPaths({ dataDir: layout.dataRoot })

  // Bootstrap AS tokens and export to env BEFORE parsing zooid.yaml. The
  // parser's MATRIX_AS_TOKEN / MATRIX_HS_TOKEN defaults (see [ZOD048]) and
  // any explicit `${MATRIX_AS_TOKEN}` interpolations both need the vars set.
  const tokens = ensureTokens(paths.envPath)
  process.env.MATRIX_AS_TOKEN = tokens.asToken
  process.env.MATRIX_HS_TOKEN = tokens.hsToken

  const rawYaml = readFileSync(found.path, 'utf8')
  const preview = loadZooidConfig(rawYaml, { configDir: dirname(found.path) })
  const matrix = findMatrixTransport(preview)
  if (!matrix) {
    throw new Error('zooid.yaml: zooid dev requires at least one matrix transport')
  }
  const agentUserIds = Object.values(preview.agents)
    .filter((a) => a.matrix?.transport === matrix.name)
    .map((a) => a.matrix!.user_id)
  const shape = deriveHomeserverShape(matrix.transport, agentUserIds)
  const port = flags.hostPort ?? shape.port
  const homeserver = `http://localhost:${port}`

  await ensureDayFolder(logPaths)
  await pruneOldDays({ dataDir: layout.dataRoot, retainDays: 14 })

  const ctx: DevCtx = { logPaths, tokens }

  const tasks = new Listr<DevCtx>(
    [
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
        task: () => {
          ctx.svc = new TuwunelService({
            name: 'zooid-tuwunel',
            hostPort: port,
            paths,
            engine: flags.engine,
          })
          const child = ctx.svc.start()
          ctx.tuwunelCaptureDone = captureChildToFile(child, logPaths.tuwunelLog)
        },
      },
      {
        title: 'Wait for Tuwunel /_matrix/client/versions',
        task: async () => {
          if (!ctx.svc) throw new Error('service not started')
          // 180s covers Docker Desktop's first-run bind-mount setup on macOS
          // (which can sit in `created` for 30–90s before transitioning to
          // `running`) plus Tuwunel's RocksDB init. Repeated runs against an
          // existing DB are far quicker.
          await ctx.svc.waitHealthy({ url: homeserver, timeoutMs: 180_000 })
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
        task: async (_ctx, t) => {
          const captures: Record<string, AgentCapture> = {}
          for (const name of Object.keys(preview.agents)) {
            captures[name] = wireAgentCapture({
              agent: name,
              paths: logPaths,
              verbosity: 'default',
              // Matrix cross-link is a follow-up — wire to transport-matrix's
              // most-recent (room_id, event_id) per session in a later cycle.
              matrixContext: () => null,
            })
          }
          ctx.captures = captures
          ctx.daemon = await startDaemon({
            configPath: found.path,
            cwd,
            installSignalHandlers: false,
            adminUserId: `@${flags.adminUser}:${shape.serverName}`,
            agentsDir: layout.agentsDir,
            // Local-only homeserver: make the workforce space publicly joinable
            // so a self-service-registered dev account lands in #<space> from
            // the web client without needing an invite.
            publicWorkforceSpace: true,
            onTap: (agentName, event) => captures[agentName]?.onTap(event),
            prepullLog: (line) => {
              t.output = line.replace(/^\[zooid\]\s+/, '').trim()
            },
          })
        },
      },
      ...(flags.watchWeb
        ? [
            {
              title: 'Start @zooid/web watcher (vite build --watch)',
              task: async (): Promise<void> => {
                const pkgDir =
                  typeof flags.watchWeb === 'string'
                    ? resolve(flags.watchWeb)
                    : webSourcePackage(CLI_ROOT)
                if (!pkgDir) {
                  const defaultPath = dirname(dirname(dirname(CLI_ROOT))) + '/zooid-clients/packages/web'
                  throw new Error(
                    `--watch-web: @zooid/web not found at ${defaultPath}.\n` +
                      `Pass an explicit path: --watch-web=/path/to/zooid-clients/packages/web`,
                  )
                }
                ctx.webWatch = await startWebWatch({ webPackageDir: pkgDir })
              },
            },
          ]
        : []),
      {
        title: `Serve @zooid/web on http://localhost:${flags.uiPort}`,
        task: async (_, t) => {
          const webRoot =
            ctx.webWatch?.distPath ??
            (await ensureWebRoot({
              cliRoot: CLI_ROOT,
              cacheDir: join(layout.dataRoot, 'web'),
              version: readZoonWebPin(CLI_ROOT),
              onProgress: (msg) => {
                t.output = msg
              },
            }))
          const app = webStatic({ webRoot, homeserverUrl: homeserver })
          ctx.uiServer = serve({ fetch: app.fetch, port: flags.uiPort })
        },
      },
    ],
    { concurrent: false, exitOnError: true },
  )

  await tasks.run()

  // Listr's interactive renderer is done — start streaming the watcher's
  // output to our terminal so vite rebuild logs are visible.
  ctx.webWatch?.attachStdio()

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
    stopWebWatch: async () => {
      await ctx.webWatch?.stop()
    },
    stopCaptures: async () => {
      if (!ctx.captures) return
      await Promise.all(Object.values(ctx.captures).map((c) => c.close()))
    },
    finalizeTuwunelCapture: async () => {
      if (ctx.tuwunelCaptureDone) await ctx.tuwunelCaptureDone
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
      `  ${chalk.cyan('data dir:')} ${layout.dataRoot}`,
      ...(ctx.webWatch
        ? [`  ${chalk.cyan('web watcher:')} live (vite build --watch on @zooid/web)`]
        : []),
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

function loadEnvFiles(cwd: string): void {
  // .env.local takes precedence over .env, but neither overrides shell-exported
  // vars — process.loadEnvFile() refuses to overwrite already-set keys.
  for (const name of ['.env.local', '.env']) {
    const path = resolve(cwd, name)
    if (!existsSync(path)) continue
    try {
      process.loadEnvFile(path)
    } catch (err) {
      console.warn(`[zooid dev] failed to load ${name}: ${(err as Error).message}`)
    }
  }
}
