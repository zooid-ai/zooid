import { resolve } from 'node:path'
import { cac } from 'cac'
import { runDev } from './commands/dev.js'
import { runLogs } from './commands/logs.js'
import { runStart } from './commands/start.js'
import { runStatus } from './commands/status.js'

const cli = cac('zooid')

cli
  .command('start', 'Run the daemon (production entry-point)')
  .option('--data <dir>', 'Persistent data root dir', { default: './data' })
  .option('--runtime <local|docker|podman>', 'Agent runtime')
  .option('--image <ref>', 'Agent container image')
  .option('--print-token', 'Print a 32-byte hex token and exit')
  .action(async (flags) => {
    await runStart({
      dataDir: flags.data,
      runtime: flags.runtime,
      image: flags.image,
      printToken: flags.printToken,
    })
  })

cli
  .command('dev', 'Tuwunel + daemon + UI for local development')
  .option('--data <dir>', 'Persistent data root dir', { default: './data' })
  .option('--engine <docker|podman>', 'Container engine', { default: 'docker' })
  .option('--ui-port <n>', 'UI HTTP port', { default: 5173 })
  .option('--admin-user <name>', 'Admin username', { default: 'admin' })
  .option('--admin-password <pw>', 'Admin password', { default: 'admin' })
  .option('--watch-web', 'Run vite build --watch on @zoon/web (monorepo source only)')
  .action(async (flags) => {
    await runDev({
      dataDir: flags.data,
      engine: flags.engine,
      uiPort: Number(flags.uiPort),
      adminUser: flags.adminUser,
      adminPassword: flags.adminPassword,
      watchWeb: Boolean(flags.watchWeb),
    })
  })

cli
  .command(
    'logs [source]',
    'Read captured logs. source=tuwunel|daemon|dev|agent-<name>[.acp], or "prune" to delete old days',
  )
  .option('--data <dir>', 'Persistent data root dir', { default: './data' })
  .option('--day <YYYY-MM-DD>', 'Day partition (defaults to today)')
  .option('--turn <id>', 'Filter ACP taps to a single turn id')
  .option('-f, --follow', 'Tail the file (not yet implemented)')
  .option('--keep <n>', 'For `logs prune`: days to retain', { default: 14 })
  .action(async (source, flags) => {
    if (source === 'prune') {
      await runLogs({
        dataDir: resolve(process.cwd(), flags.data),
        subcommand: 'prune',
        keep: Number(flags.keep),
      })
      return
    }
    await runLogs({
      dataDir: resolve(process.cwd(), flags.data),
      source,
      day: flags.day,
      turn: flags.turn,
      follow: Boolean(flags.follow),
    })
  })

cli
  .command('status', 'Print Tuwunel + daemon health')
  .option('--data <dir>', 'Persistent data root dir', { default: './data' })
  .option('--port <n>', 'Tuwunel host port (defaults to zooid.yaml)')
  .action(async (flags) => {
    await runStatus({
      dataDir: flags.data,
      port: flags.port !== undefined ? Number(flags.port) : undefined,
    })
  })

cli.help()
cli.version('0.0.1')
cli.parse()
