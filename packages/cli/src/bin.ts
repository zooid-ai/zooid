import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { serve } from '@hono/node-server'
import {
  ApprovalCorrelator,
  findConfigFile,
  findHttpTransport,
  findMatrixTransport,
  loadWorkforceConfig,
  mergeCliFlags,
  type CliFlags,
} from '@zooid/core'
import { createApp } from '@zooid/transport-http'
import {
  MatrixClient,
  createMatrixTransport,
  type AgentBinding,
} from '@zooid/transport-matrix'
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
  --runtime <local|docker|podman>
                               Runtime for spawning each agent's ACP shim. Default: docker.
  --image <ref>                Container image for runtime: docker. Default: ghcr.io/zooid-ai/zooid-agent-base:latest.
  --print-token                Print a fresh 32-byte hex token and exit.
  --help, -h                   Print this help and exit.

Environment:
  ZOOID_TOKEN                  Required for http transport. Bearer token clients
                               send as "Authorization: Bearer $ZOOID_TOKEN".

Config:
  ./workforce.yaml             Required. Each agent must declare an "acp" block
                               and reference a transport by name:
                                 runtime: docker
                                 transports:
                                   http-local:
                                     type: http
                                     port: 8080
                                 agents:
                                   qa:
                                     transport: http-local
                                     workdir: ./workspaces/qa
                                     acp: { preset: claude }
                                   ship:
                                     transport: http-local
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
    const a = argv[i]!
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) {
        console.error(`flag ${a} requires a value`)
        process.exit(2)
      }
      return v
    }
    switch (a) {
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

  const found = findConfigFile(process.cwd())
  if (!found) {
    console.error('workforce.yaml is required in the current directory')
    process.exit(1)
  }
  const base = loadWorkforceConfig(readFileSync(found.path, 'utf8'))
  const config = mergeCliFlags(base, flags)

  const approvals = new ApprovalCorrelator()
  const registry = buildAcpRegistry(config, { approvals })

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

  const matrix = findMatrixTransport(config)
  if (matrix) {
    const client = new MatrixClient({
      homeserver: matrix.transport.homeserver,
      asToken: matrix.transport.as_token,
    })
    const bindings: AgentBinding[] = []
    for (const a of Object.values(config.agents)) {
      if (a.transport !== matrix.name) continue
      if (!a.matrix_user_id || !a.rooms || !a.trigger) {
        console.error(`agent ${a.name}: matrix_user_id, rooms, and trigger are required`)
        process.exit(1)
      }
      bindings.push({
        name: a.name,
        userId: a.matrix_user_id,
        rooms: a.rooms,
        trigger: a.trigger,
      })
    }
    const transport = createMatrixTransport({
      agents: registry,
      approvals,
      client,
      bindings,
      hsToken: matrix.transport.hs_token,
    })
    await transport.bootstrap()
    const port = matrix.transport.port ?? 8080
    serve({ fetch: transport.app.fetch, port }, (info) => {
      console.log(`zooid (matrix AS) listening on http://localhost:${info.port}`)
      for (const b of bindings) {
        console.log(`  agent: ${b.name} (${b.userId}, trigger: ${b.trigger})`)
      }
    })
    return
  }

  const http = findHttpTransport(config)
  if (!http) {
    console.error('no transport declared in workforce.yaml')
    process.exit(1)
  }

  const token = process.env.ZOOID_TOKEN
  if (!token) {
    console.error('ZOOID_TOKEN is required')
    process.exit(1)
  }
  const app = createApp({ agents: registry, approvals, token })
  serve({ fetch: app.fetch, port: http.transport.port }, (info) => {
    console.log(`zooid listening on http://localhost:${info.port}`)
    for (const name of Object.keys(config.agents)) {
      console.log(`  agent: ${name} (workdir: ${config.agents[name]!.workdir})`)
    }
  })
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
