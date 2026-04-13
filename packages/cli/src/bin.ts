import { readFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { serve } from '@hono/node-server'
import {
  loadConfig,
  mergeCliFlags,
  type BuddConfig,
  type CliFlags,
} from '@zooid/budd-core'
import { createApp } from '@zooid/budd-transport-http'
import { buildRuntime, createDefaultSessionRunner } from './index.js'

interface ParsedFlags extends CliFlags {
  printToken?: boolean
  help?: boolean
}

function printHelp(): void {
  process.stdout.write(
    `budd — daemon that exposes a coding-agent CLI behind an HTTP API.

Usage:
  budd [flags]

Flags:
  --transport <http>           Transport to listen on (only "http" is supported in MVP).
  --port <n>                   Port for the HTTP transport. Default: 8080 (or daemon.yaml).
  --runtime <local|docker>     Runtime for spawning the agent. Default: docker.
  --image <ref>                Container image to run when --runtime docker.
                               Default: budd/claude-code:latest (or daemon.yaml docker.image).
  --workdir <path>             Host directory to mount at /workspace inside the container.
                               Default: current working directory.
  --pre-turn <cmd>             Shell command to run before each turn. Overrides daemon.yaml.
  --post-turn <cmd>            Shell command to run after each turn. Overrides daemon.yaml.
  --print-token                Print a fresh 32-byte hex token and exit.
  --help, -h                   Print this help and exit.

Environment:
  BUDD_TOKEN                   Required. Bearer token clients send as
                               "Authorization: Bearer $BUDD_TOKEN".

Config:
  ./daemon.yaml                Optional. Loaded from the current directory if present.

HTTP API:
  POST /sessions               Start a new session. Body: {"prompt":"..."}. SSE stream.
  POST /sessions/:id/turns     Resume an existing session. Body: {"prompt":"..."}. SSE stream.
  GET  /sessions/:id/events    Tail the session's event stream (reattach after disconnect,
                               or read history). SSE response. 404 if no stream is available.

Example:
  $ export BUDD_TOKEN=$(budd --print-token)
  $ budd --port 8080 &
  $ curl -N -H "Authorization: Bearer $BUDD_TOKEN" \\
         -H "content-type: application/json" \\
         -d '{"prompt":"fix the auth bug"}' \\
         http://localhost:8080/sessions
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
      case '--pre-turn':
        flags.preTurn = next()
        break
      case '--post-turn':
        flags.postTurn = next()
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

  let base: BuddConfig = {
    transport: 'http',
    port: 8080,
    runtime: 'docker',
    docker: { image: 'budd/claude-code:latest' },
    hooks: {},
  }
  if (existsSync('daemon.yaml')) {
    base = loadConfig(readFileSync('daemon.yaml', 'utf8'))
  }
  const config = mergeCliFlags(base, flags)

  const token = process.env.BUDD_TOKEN
  if (!token) {
    console.error('BUDD_TOKEN is required')
    process.exit(1)
  }

  const runtime = buildRuntime({
    runtime: config.runtime,
    docker: config.docker,
    workdir: config.workdir,
  })
  const runner = createDefaultSessionRunner({
    runtime,
    hooks: config.hooks,
  })
  const app = createApp({ runner, token })

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`budd listening on http://localhost:${info.port}`)
  })
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
