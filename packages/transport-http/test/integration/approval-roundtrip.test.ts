import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { LocalAcpRuntime } from '@zooid/runtime-local'
import { AcpAgentRegistry, ApprovalCorrelator } from '@zooid/core'
import { createApp } from '../../src/server.js'
import { serve } from '@hono/node-server'

const fixturePath = fileURLToPath(
  new URL('../../../acp-client/test/fixtures/echo-agent.ts', import.meta.url),
)

describe('approval round-trip via HTTP', () => {
  it('streams approval.request, accepts a decision, completes the prompt', async () => {
    const registry = new AcpAgentRegistry({
      runtime: new LocalAcpRuntime(),
      agents: {
        echo: {
          name: 'echo',
          workdir: process.cwd(),
          hooks: {},
          acp: { command: process.execPath, args: ['--import', 'tsx', fixturePath] },
          approval_timeout_ms: 0,
        },
      },
    })
    const approvals = new ApprovalCorrelator()
    const app = createApp({ agents: registry, approvals, token: 'test-token' })

    const server = serve({ fetch: app.fetch, port: 0 })
    await new Promise<void>((r) => setTimeout(r, 50))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const base = `http://127.0.0.1:${port}`

    try {
      const res = await fetch(`${base}/agents/echo/sessions`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt: 'hi' }),
      })
      expect(res.status).toBe(200)

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let approvalId: string | undefined
      let sessionId: string | undefined

      while (!approvalId) {
        const { value, done } = await reader.read()
        if (done) throw new Error('stream ended before approval.request')
        buffer += decoder.decode(value, { stream: true })
        for (const frame of buffer.split('\n\n')) {
          const m = /^data: (.*)$/m.exec(frame)
          if (!m) continue
          const evt = JSON.parse(m[1])
          if (evt.type === 'session.start') sessionId = evt.session_id
          if (evt.type === 'approval.request') approvalId = evt.approval_id
        }
      }

      expect(sessionId).toBeDefined()
      expect(approvalId).toBeDefined()

      const decisionRes = await fetch(
        `${base}/agents/echo/sessions/${sessionId}/approvals/${approvalId}`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ decision: 'allow', option_id: 'allow-once' }),
        },
      )
      expect(decisionRes.status).toBe(200)

      let sawTurnEnd = false
      let stopReason: string | undefined
      while (!sawTurnEnd) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (const frame of buffer.split('\n\n')) {
          const m = /^data: (.*)$/m.exec(frame)
          if (!m) continue
          const evt = JSON.parse(m[1])
          if (evt.type === 'turn.end') {
            sawTurnEnd = true
            stopReason = evt.stop_reason
          }
        }
      }
      expect(sawTurnEnd).toBe(true)
      expect(stopReason).toBe('end_turn')
    } finally {
      await registry.stopAll()
      server.close()
    }
  }, 20_000)
})
