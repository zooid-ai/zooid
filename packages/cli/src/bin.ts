import { cac } from 'cac'
import { runDev } from './commands/dev.js'
import { runStart } from './commands/start.js'
import { runStatus } from './commands/status.js'

const cli = cac('zooid')

cli
  .command('start', 'Run the daemon (production entry-point)')
  .option('--runtime <local|docker|podman>', 'Agent runtime')
  .option('--image <ref>', 'Agent container image')
  .option('--print-token', 'Print a 32-byte hex token and exit')
  .action(async (flags) => {
    await runStart({
      runtime: flags.runtime,
      image: flags.image,
      printToken: flags.printToken,
    })
  })

cli
  .command('dev', 'Tuwunel + daemon + UI for local development')
  .option('--data <dir>', 'Persistent data dir', { default: './data/matrix' })
  .option('--engine <docker|podman>', 'Container engine', { default: 'docker' })
  .option('--ui-port <n>', 'UI HTTP port', { default: 5173 })
  .option('--admin-user <name>', 'Admin username', { default: 'admin' })
  .option('--admin-password <pw>', 'Admin password', { default: 'admin' })
  .action(async (flags) => {
    await runDev({
      dataDir: flags.data,
      engine: flags.engine,
      uiPort: Number(flags.uiPort),
      adminUser: flags.adminUser,
      adminPassword: flags.adminPassword,
    })
  })

cli
  .command('status', 'Print Tuwunel + daemon health')
  .option('--data <dir>', 'Persistent data dir', { default: './data/matrix' })
  .option('--port <n>', 'Tuwunel host port (defaults to workforce.yaml)')
  .action(async (flags) => {
    await runStatus({
      dataDir: flags.data,
      port: flags.port !== undefined ? Number(flags.port) : undefined,
    })
  })

cli.help()
cli.version('0.0.1')
cli.parse()
