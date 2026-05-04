// Triage-agent end-to-end smoke. Gated on ANTHROPIC_API_KEY so CI without
// the key still passes. When run, this exercises the full Plan-02 flow:
// HTTP POST /sessions → SSE → tool_call → approval.request → POST decision →
// turn.end, with a real ticket file landing under tickets/.
//
// Lives under packages/transport-http (not examples/triage-agent) so the
// existing vitest pipeline picks it up without adding a package.json
// inside the example.
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAcpRuntime } from '@zooid/runtime-local'
import { AcpAgentRegistry, ApprovalCorrelator } from '@zooid/core'
import { createApp } from '../../src/server.js'
import { serve } from '@hono/node-server'

const exampleDir = fileURLToPath(
  new URL('../../../../examples/triage-agent', import.meta.url),
)

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY

describe.skipIf(!HAS_KEY)('triage-agent live smoke (requires ANTHROPIC_API_KEY)', () => {
  it('produces a ticket via the full SSE → approval → turn.end flow', async () => {
    const ticketsDir = mkdtempSync(join(tmpdir(), 'zooid-triage-tickets-'))
    try {
      const registry = new AcpAgentRegistry({
        runtime: new LocalAcpRuntime(),
        agents: {
          default: {
            name: 'default',
            workdir: exampleDir,
            hooks: {},
            acp: { preset: 'claude' },
            approval_timeout_ms: 0,
            docker: { forward_env: ['ANTHROPIC_API_KEY'] },
          },
        },
        forwardEnv: {
          default: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
        },
      })
      const approvals = new ApprovalCorrelator()
      const app = createApp({ agents: registry, approvals, token: 't' })
      const server = serve({ fetch: app.fetch, port: 0 })
      await new Promise((r) => setTimeout(r, 50))
      const port = (server.address() as { port: number }).port
      const base = `http://127.0.0.1:${port}`

      try {
        const res = await fetch(`${base}/agents/default/sessions`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer t',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt: `the get started button on the homepage is too small. Write the ticket to ${ticketsDir}.`,
          }),
        })
        expect(res.status).toBe(200)

        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let sessionId: string | undefined
        let sawTurnEnd = false
        let stopReason: string | undefined

        // Auto-allow every approval as it shows up.
        while (!sawTurnEnd) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          for (const frame of buffer.split('\n\n')) {
            const m = /^data: (.*)$/m.exec(frame)
            if (!m) continue
            const evt = JSON.parse(m[1])
            if (evt.type === 'session.start') sessionId = evt.session_id
            if (evt.type === 'approval.request' && sessionId) {
              await fetch(
                `${base}/agents/default/sessions/${sessionId}/approvals/${evt.approval_id}`,
                {
                  method: 'POST',
                  headers: {
                    Authorization: 'Bearer t',
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    decision: 'allow',
                    option_id: 'allow-once',
                  }),
                },
              )
            }
            if (evt.type === 'turn.end') {
              sawTurnEnd = true
              stopReason = evt.stop_reason
            }
          }
        }
        expect(sawTurnEnd).toBe(true)
        expect(stopReason).toBe('end_turn')

        const files = readdirSync(ticketsDir).filter((f) => f.endsWith('.md'))
        expect(files.length).toBeGreaterThan(0)
      } finally {
        await registry.stopAll()
        server.close()
      }
    } finally {
      rmSync(ticketsDir, { recursive: true, force: true })
    }
  }, 180_000)
})
