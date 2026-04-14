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
docker: { image: budd/claude:latest }
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
docker: { image: budd/claude:latest }
agents:
  qa:
    workdir: .
  ship:
    workdir: .
    adapter: codex
    docker: { image: budd/codex:latest }
`)
    const runners = buildRunnersFromConfig(config)
    expect((runners.qa.runtime as DockerRuntime).image).toBe('budd/claude:latest')
    expect((runners.ship.runtime as DockerRuntime).image).toBe('budd/codex:latest')
  })

  it('unknown adapter name → clear error at build time', () => {
    const config = loadConfig(`
transport: http
runtime: docker
docker: { image: budd/claude:latest }
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
docker: { image: budd/claude:latest }
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
    // SessionRunner doesn't expose extraMounts directly; assert by peeking
    // at the private opts shape — this is a known boundary for the test.
    const opts = (runners.qa as unknown as { opts: { extraMounts?: { path: string }[] } })
      .opts
    expect(opts.extraMounts?.[0]?.path).toBe('/etc/budd/shared-docs')
  })
})
