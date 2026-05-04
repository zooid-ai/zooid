import { readFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { serve } from '@hono/node-server'
import { loadConfig, mergeCliFlags, type CliFlags } from '@zooid/core'
import { createApp } from '@zooid/transport-http'
import { buildRunnersFromConfig } from './index.js'

interface ParsedFlags extends CliFlags {
  printToken?: boolean
  help?: boolean
}

function printHelp(): void {
  process.stdout.write(
    `zooid — daemon that exposes coding-agent CLIs behind an HTTP API.

Usage:
  zooid [flags]

Flags:
  --transport <http>           Transport to listen on (only "http" is supported).
  --port <n>                   Port for the HTTP transport. Default: 8080 (or daemon.yaml).
  --runtime <local|docker>     Runtime for spawning the agent. Default: docker.
  --image <ref>                Container image to run when --runtime docker.
                               Default: ghcr.io/zooid-ai/budd-agent-claude-code:latest (or daemon.yaml docker.image).
  --print-token                Print a fresh 32-byte hex token and exit.
  --help, -h                   Print this help and exit.

Environment:
  ZOOID_TOKEN                   Required. Bearer token clients send as
                               "Authorization: Bearer $ZOOID_TOKEN".

Config:
  ./daemon.yaml                Required. Must define agents: with at least one
                               entry. Example:
                                 transport: http
                                 runtime: docker
                                 agents:
                                   qa:
                                     workdir: ./workspaces/qa
                                   product:
                                     workdir: ./workspaces/product

HTTP API:
  POST /agents/:name/sessions              Start a session for the named agent.
  POST /agents/:name/sessions/:id/turns    Resume a session.
  GET  /agents/:name/sessions/:id/events   Tail a session's event stream.

Example:
  $ export ZOOID_TOKEN=$(zooid --print-token)
  $ zooid --port 8080 &
  $ curl -N -H "Authorization: Bearer $ZOOID_TOKEN" \\
         -H "content-type: application/json" \\
         -d '{"prompt":"fix the auth bug"}' \\
         http://localhost:8080/agents/qa/sessions
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

  if (!existsSync('daemon.yaml')) {
    console.error('daemon.yaml is required in the current directory')
    console.error('minimal example:')
    console.error('  transport: http')
    console.error('  runtime: docker')
    console.error('  agents:')
    console.error('    default:')
    console.error('      workdir: .')
    process.exit(1)
  }
  const base = loadConfig(readFileSync('daemon.yaml', 'utf8'))
  const config = mergeCliFlags(base, flags)

  const token = process.env.ZOOID_TOKEN
  if (!token) {
    console.error('ZOOID_TOKEN is required')
    process.exit(1)
  }

  const runners = buildRunnersFromConfig(config)
  const app = createApp({ runners, token })

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`zooid listening on http://localhost:${info.port}`)
    for (const name of Object.keys(runners)) {
      console.log(`  agent: ${name} (workdir: ${config.agents[name].workdir})`)
    }
  })
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
