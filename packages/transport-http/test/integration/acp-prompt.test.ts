import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { LocalAcpRuntime } from '@zooid/runtime-local'
import { AcpAgentRegistry } from '@zooid/core'
import { createApp } from '../../src/server.js'

const fixturePath = fileURLToPath(
  new URL('../../../acp-client/test/fixtures/echo-agent.ts', import.meta.url),
)
const TOKEN = 'integration-token-0123456789abcdef'

describe('POST /agents/echo/sessions integration with echo ACP fixture', () => {
  it('streams session.start → ACP events → turn.end via SSE', async () => {
    const reg = new AcpAgentRegistry({
      runtime: new LocalAcpRuntime(),
      agents: {
        echo: {
          name: 'echo',
          workdir: process.cwd(),
          hooks: {},
          acp: { command: process.execPath, args: ['--import', 'tsx', fixturePath] },
        },
      },
    })
    const app = createApp({ agents: reg, token: TOKEN })

    try {
      const res = await app.request('/agents/echo/sessions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ prompt: 'hello' }),
      })
      expect(res.status).toBe(200)

      const text = await res.text()
      const frames = text
        .split('\n\n')
        .filter((f) => f.startsWith('data: '))
        .map((f) => JSON.parse(f.slice('data: '.length)) as Record<string, unknown>)

      expect(frames[0]).toMatchObject({ type: 'session.start' })
      expect(frames.some((f) => f.type === 'turn.start')).toBe(true)
      const last = frames[frames.length - 1]
      expect(last.type).toBe('turn.end')
      // Default approval is `cancel`; echo fixture returns `cancelled` then.
      expect(last.stop_reason).toBe('cancelled')
    } finally {
      await reg.stopAll()
    }
  }, 20_000)
})
