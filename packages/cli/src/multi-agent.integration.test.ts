import { describe, it, expect } from 'vitest'
import { loadConfig } from '@zooid/budd-core'
import { createApp } from '@zooid/budd-transport-http'
import { DockerRuntime } from '@zooid/budd-runtime-docker'
import { claudeAdapter } from '@zooid/budd-adapter-claude'
import { codexAdapter } from '@zooid/budd-adapter-codex'
import { buildRunnersFromConfig } from './index.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const FIXTURES_BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../adapter-claude/tests/fixtures/bin',
)

describe('buildRunnersFromConfig', () => {
  it('builds one runner per agent, routes correctly', async () => {
    const config = loadConfig(`
transport: http
runtime: local
agents:
  qa:
    workdir: .
  product:
    workdir: .
`)
    const runners = buildRunnersFromConfig(config, { pathPrefix: FIXTURES_BIN })
    expect(Object.keys(runners).sort()).toEqual(['product', 'qa'])

    const app = createApp({ runners, token: 'tok' })
    const res = await app.request('/agents/qa/sessions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer tok',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prompt: 'hi' }),
    })
    expect(res.status).toBe(200)
  })
})

describe('buildRunnersFromConfig — per-agent adapter + image', () => {
  it('each runner uses the agent-specified adapter', () => {
    const config = loadConfig(`
transport: http
runtime: docker
docker: { image: budd/claude-code:latest }
agents:
  qa:
    workdir: .
  ship:
    workdir: .
    adapter: codex
    docker: { image: budd/codex:latest }
`)
    const runners = buildRunnersFromConfig(config)
    expect(runners.qa.adapter).toBe(claudeAdapter)
    expect(runners.ship.adapter).toBe(codexAdapter)
  })

  it('each runner has its own DockerRuntime with the per-agent image', () => {
    const config = loadConfig(`
transport: http
runtime: docker
docker: { image: budd/claude-code:latest }
agents:
  qa:
    workdir: .
  ship:
    workdir: .
    adapter: codex
    docker: { image: budd/codex:latest }
`)
    const runners = buildRunnersFromConfig(config)
    expect((runners.qa.runtime as DockerRuntime).image).toBe('budd/claude-code:latest')
    expect((runners.ship.runtime as DockerRuntime).image).toBe('budd/codex:latest')
  })

  it('unknown adapter name → clear error at build time', () => {
    const config = loadConfig(`
transport: http
runtime: docker
docker: { image: budd/claude-code:latest }
agents:
  qa:
    workdir: .
    adapter: opencode
`)
    expect(() => buildRunnersFromConfig(config)).toThrow(
      /agents\.qa\.adapter "opencode" not registered/i,
    )
  })

  it('runtime: docker requires an image (daemon-wide OR per-agent)', () => {
    // loadConfig always injects DEFAULT_DOCKER_IMAGE, so to test the
    // "no image anywhere" branch we construct a raw BuddConfig manually.
    const config = {
      transport: 'http' as const,
      port: 8080,
      runtime: 'docker' as const,
      docker: {},
      agents: { qa: { name: 'qa', workdir: '.', hooks: {} } },
      hooks: {},
    }
    expect(() => buildRunnersFromConfig(config)).toThrow(
      /agents\.qa.*image.*required.*runtime.*docker/i,
    )
  })

  it('resolves relative docker.mounts.extra[].path against configDir', () => {
    const config = loadConfig(`
transport: http
runtime: docker
docker: { image: budd/claude-code:latest }
agents:
  qa:
    workdir: .
    docker:
      mounts:
        extra:
          - path: ./shared-docs
            target: /workspace/docs
            mode: ro
`)
    const runners = buildRunnersFromConfig(config, { configDir: '/etc/budd' })
    const opts = (runners.qa as unknown as { opts: { extraMounts?: { path: string }[] } })
      .opts
    expect(opts.extraMounts?.[0]?.path).toBe('/etc/budd/shared-docs')
  })
})

describe('BUILTIN_ADAPTERS — factory registry', () => {
  it('exports factories, not singletons', async () => {
    const { BUILTIN_ADAPTERS } = await import('./index.js')
    for (const factory of Object.values(BUILTIN_ADAPTERS)) {
      expect(typeof factory).toBe('function')
    }
  })

  it('claude factory ignores options and returns claudeAdapter', async () => {
    const { BUILTIN_ADAPTERS } = await import('./index.js')
    const inst = BUILTIN_ADAPTERS.claude({})
    expect(inst).toBe(claudeAdapter)
  })

  it('codex factory ignores options and returns codexAdapter', async () => {
    const { BUILTIN_ADAPTERS } = await import('./index.js')
    const inst = BUILTIN_ADAPTERS.codex({ ignored: true })
    expect(inst).toBe(codexAdapter)
  })
})

describe('buildRunnersFromConfig — factory invocation', () => {
  it('passes adapter.options to the factory', () => {
    const config = loadConfig(`
transport: http
runtime: docker
docker: { image: budd/claude-code:latest }
agents:
  review:
    workdir: .
    adapter:
      type: stub
      options:
        model: anthropic/claude-sonnet-4-6
    docker: { image: stub:latest }
`)
    let receivedOpts: Record<string, unknown> | undefined
    const stubAdapter = {
      name: 'stub',
      envPassthrough: ['ANTHROPIC_API_KEY'],
      isAvailable: () => true,
      prepareNewSession: () => ({ strategy: 'preassigned' as const, session_id: 'x' }),
      spawn: () => ({ command: 'true', args: [] }),
    }
    const adapters = {
      stub: (opts: Record<string, unknown>) => {
        receivedOpts = opts
        return stubAdapter
      },
    }
    buildRunnersFromConfig(config, { adapters })
    expect(receivedOpts).toEqual({ model: 'anthropic/claude-sonnet-4-6' })
  })

  it('passes empty options object when adapter is string shorthand', () => {
    const config = loadConfig(`
transport: http
runtime: docker
docker: { image: budd/claude-code:latest }
agents:
  qa:
    workdir: .
    adapter: stub
`)
    let receivedOpts: Record<string, unknown> | undefined
    const stub = {
      name: 'stub',
      isAvailable: () => true,
      prepareNewSession: () => ({ strategy: 'preassigned' as const, session_id: 'x' }),
      spawn: () => ({ command: 'true', args: [] }),
    }
    const adapters = {
      stub: (opts: Record<string, unknown>) => {
        receivedOpts = opts
        return stub
      },
    }
    buildRunnersFromConfig(config, { adapters })
    expect(receivedOpts).toEqual({})
  })

  it('factory throws → error is prefixed with agents.<name>.adapter.options', () => {
    const config = loadConfig(`
transport: http
runtime: docker
docker: { image: budd/claude-code:latest }
agents:
  review:
    workdir: .
    adapter:
      type: stub
      options:
        model: bad
`)
    const adapters = {
      stub: () => {
        throw new Error('model must include provider prefix')
      },
    }
    expect(() => buildRunnersFromConfig(config, { adapters })).toThrow(
      /agents\.review\.adapter\.options: model must include provider prefix/,
    )
  })

  it('unknown adapter name still errors clearly (existing behavior preserved)', () => {
    const config = loadConfig(`
transport: http
runtime: docker
docker: { image: budd/claude-code:latest }
agents:
  qa:
    workdir: .
    adapter: doesnotexist
`)
    expect(() => buildRunnersFromConfig(config)).toThrow(
      /agents\.qa\.adapter "doesnotexist" not registered/i,
    )
  })
})
