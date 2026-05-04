import { readFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { serve } from '@hono/node-server'
import { loadConfig, mergeCliFlags, type CliFlags } from '@zooid/core'
import { createApp } from '@zooid/transport-http'
import { buildAcpRegistry } from './build-registry.js'

interface ParsedFlags extends CliFlags {
  printToken?: boolean
  help?: boolean
}

function printHelp(): void {
  process.stdout.write(
    `zooid — daemon that exposes ACP-speaking coding agents behind an HTTP API.

Usage:
  zooid [flags]

Flags:
  --transport <http>           Transport to listen on (only "http" is supported).
  --port <n>                   Port for the HTTP transport. Default: 8080 (or daemon.yaml).
  --runtime <local|docker|podman>
                               Runtime for spawning each agent's ACP shim. Default: docker.
  --image <ref>                Container image for runtime: docker. Default: ghcr.io/zooid-ai/zooid-agent-base:latest.
  --print-token                Print a fresh 32-byte hex token and exit.
  --help, -h                   Print this help and exit.

Environment:
  ZOOID_TOKEN                  Required. Bearer token clients send as
                               "Authorization: Bearer $ZOOID_TOKEN".

Config:
  ./daemon.yaml                Required. Each agent must declare an "acp" block:
                                 transport: http
                                 runtime: docker
                                 agents:
                                   qa:
                                     workdir: ./workspaces/qa
                                     acp: { preset: claude }
                                   ship:
                                     workdir: ./workspaces/ship
                                     acp: { preset: codex }

HTTP API:
  POST /agents/:name/sessions              Start a new session for the named agent.
  GET  /agents/:name/sessions/:id/events   Reattach to an in-flight session's SSE stream.
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
    process.exit(1)
  }
  const base = loadConfig(readFileSync('daemon.yaml', 'utf8'))
  const config = mergeCliFlags(base, flags)

  const token = process.env.ZOOID_TOKEN
  if (!token) {
    console.error('ZOOID_TOKEN is required')
    process.exit(1)
  }

  const registry = buildAcpRegistry(config)
  const app = createApp({ agents: registry, token })

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`received ${signal}, stopping agents...`)
    try {
      await registry.stopAll()
    } catch (err) {
      console.error('error during stopAll:', err)
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`zooid listening on http://localhost:${info.port}`)
    for (const name of Object.keys(config.agents)) {
      console.log(`  agent: ${name} (workdir: ${config.agents[name].workdir})`)
    }
  })
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
