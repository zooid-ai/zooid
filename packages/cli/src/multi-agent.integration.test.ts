import { describe, it, expect } from 'vitest'
import { loadConfig } from '@zooid/budd-core'
import { createApp } from '@zooid/budd-transport-http'
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
