import { readFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { serve } from '@hono/node-server'
import {
  loadConfig,
  mergeCliFlags,
  type AgentdConfig,
  type CliFlags,
} from '@zooid/agentd-core'
import { createApp } from '@zooid/agentd-transport-http'
import { buildRuntime, createDefaultSessionRunner } from './index.js'

interface ParsedFlags extends CliFlags {
  printToken?: boolean
  help?: boolean
}

function printHelp(): void {
  process.stdout.write(
    `agentd — daemon that exposes a coding-agent CLI behind an HTTP API.

Usage:
  agentd [flags]

Flags:
  --transport <http>           Transport to listen on (only "http" is supported in MVP).
  --port <n>                   Port for the HTTP transport. Default: 8080 (or daemon.yaml).
  --runtime <local|docker>     Runtime for spawning the agent. Default: docker.
  --image <ref>                Container image to run when --runtime docker.
                               Default: zooid/agentd-claude:latest (or daemon.yaml image:).
  --workdir <path>             Host directory to mount at /workspace inside the container.
                               Default: current working directory.
  --pre-start <cmd>            Shell command to run before each session. Overrides daemon.yaml.
  --post-end <cmd>             Shell command to run after each session. Overrides daemon.yaml.
  --print-token                Print a fresh 32-byte hex token and exit.
  --help, -h                   Print this help and exit.

Environment:
  AGENTD_TOKEN                 Required. Bearer token for POST /run. Clients send it as
                               "Authorization: Bearer $AGENTD_TOKEN".

Config:
  ./daemon.yaml                Optional. Loaded from the current directory if present.

Example:
  $ export AGENTD_TOKEN=$(agentd --print-token)
  $ agentd --port 8080 &
  $ curl -N -H "Authorization: Bearer $AGENTD_TOKEN" \\
         -H "content-type: application/json" \\
         -d '{"prompt":"fix the auth bug"}' \\
         http://localhost:8080/run
`,
  )
}

function parseArgv(argv: string[]): ParsedFlags {
  const flags: ParsedFlags = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) {
        console.error(`flag ${a} requires a value`)
        process.exit(2)
      }
      return v
    }
    switch (a) {
      case '--transport':
        flags.transport = next()
        break
      case '--port':
        flags.port = Number.parseInt(next(), 10)
        break
      case '--runtime':
        flags.runtime = next()
        break
      case '--image':
        flags.image = next()
        break
      case '--workdir':
        flags.workdir = next()
        break
      case '--pre-start':
        flags.preStart = next()
        break
      case '--post-end':
        flags.postEnd = next()
        break
      case '--print-token':
        flags.printToken = true
        break
      case '--help':
      case '-h':
        flags.help = true
        break
      default:
        if (a.startsWith('--')) {
          console.error(`unknown flag: ${a}`)
          process.exit(2)
        }
    }
  }
  return flags
}

async function main(): Promise<void> {
  const flags = parseArgv(process.argv)

  if (flags.help) {
    printHelp()
    return
  }

  if (flags.printToken) {
    process.stdout.write(`${randomBytes(32).toString('hex')}\n`)
    return
  }

  let base: AgentdConfig = {
    transport: 'http',
    port: 8080,
    runtime: 'docker',
    image: 'zooid/agentd-claude:latest',
    hooks: {},
  }
  if (existsSync('daemon.yaml')) {
    base = loadConfig(readFileSync('daemon.yaml', 'utf8'))
  }
  const config = mergeCliFlags(base, flags)

  const token = process.env.AGENTD_TOKEN
  if (!token) {
    console.error('AGENTD_TOKEN is required')
    process.exit(1)
  }

  const runtime = buildRuntime({
    runtime: config.runtime,
    image: config.image,
    workdir: config.workdir,
  })
  const runner = createDefaultSessionRunner({
    runtime,
    hooks: config.hooks,
  })
  const app = createApp({ runner, token })

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`agentd listening on http://localhost:${info.port}`)
  })
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
