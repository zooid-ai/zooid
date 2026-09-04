import { resolve } from 'node:path'
import { cac } from 'cac'
import { runDev } from './commands/dev.js'
import { runInit } from './commands/init.js'
import { resolveOptions } from './commands/init/prompts.js'
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
  .option(
    '--watch-web [path]',
    'Run vite build --watch on @zooid/web. Path defaults to sibling ../zooid-clients/packages/web.',
  )
  .action(async (flags) => {
    await runDev({
      dataDir: flags.data,
      engine: flags.engine,
      uiPort: Number(flags.uiPort),
      adminUser: flags.adminUser,
      adminPassword: flags.adminPassword,
      watchWeb: flags.watchWeb as string | boolean | undefined,
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

cli
  .command('init [dir]', 'Scaffold a new zooid workforce in the current (or named) directory')
  .option('--preset <name>', 'claude | codex | opencode | pi')
  .option('--auth <mode>', 'subscription | api-key (claude/codex/pi only)')
  .option('--model <id>', 'Model identifier')
  .option('--provider <id>', 'opencode provider: opencode-go | opencode | anthropic | openrouter | custom; pi provider: openrouter | anthropic | openai')
  .option('--api-key <value>', 'API key (api-key path; opencode always)')
  .option('--force', 'Allow scaffolding into a non-empty directory')
  .option('--overwrite', 'With --force, overwrite existing files')
  .option('--no-interactive', 'Disable prompts; require all flags up front')
  .action(async (dir: string | undefined, flags) => {
    const resolved = await resolveOptions({
      dir: dir ?? process.cwd(),
      preset: flags.preset,
      auth: flags.auth,
      model: flags.model,
      provider: flags.provider,
      apiKey: flags.apiKey,
      force: Boolean(flags.force),
      overwrite: Boolean(flags.overwrite),
      interactive: flags.interactive,
    })
    await runInit(resolved)
  })

cli.help()
cli.version('0.0.1')
cli.parse()
