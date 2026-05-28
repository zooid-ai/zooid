import { serve } from '@hono/node-server'
import { EventEmitter } from 'node:events'
import { createMatrixTransport, MatrixClient } from '../../src/index.js'

const env = process.env as Record<string, string>
const homeserver = env.MATRIX_HS
const asToken = env.MATRIX_AS_TOKEN
const hsToken = env.MATRIX_HS_TOKEN
const agentUser = env.MATRIX_AGENT_USER
const roomId = env.MATRIX_ROOM
const port = Number(env.MATRIX_PORT)

const client = new MatrixClient({ homeserver, asToken })

// Minimal echo "registry" — same shape as @zooid/core AcpRegistry.
const inner = new EventEmitter()
const echo = {
  hasAgent: (n: string) => n === 'dev',
  ensureSession: async (_n: string, threadId: string) => `sess-${threadId}`,
  prompt: async (
    _n: string,
    p: { threadId: string; content: { type: 'text'; text: string }[] },
  ) => {
    inner.emit('agentEvent', 'dev', {
      type: 'agent_message_chunk',
      sessionId: `sess-${p.threadId}`,
      content: { type: 'text', text: `echo: ${p.content[0]?.text ?? ''}` },
    })
    return { stopReason: 'end_turn' as const }
  },
  stopAll: async () => {},
  getApprovalTimeoutMs: () => 0,
  set onEvent(fn: (n: string, e: unknown) => void) {
    inner.on('agentEvent', fn)
  },
  get onEvent(): (n: string, e: unknown) => void {
    return () => {}
  },
  onApprovalRequest: async () => ({ decision: 'cancel' as const }),
}

const approvals = Object.assign(new EventEmitter(), {
  register: () => ({}),
  resolve: () => true,
  cancelSession: () => {},
  listPending: () => [],
})

const transport = createMatrixTransport({
  agents: echo as never,
  approvals: approvals as never,
  client,
  bindings: [{ name: 'dev', userId: agentUser, rooms: [{ alias: roomId }], trigger: 'any' }],
  hsToken,
})

await transport.bootstrap()
serve({ fetch: transport.app.fetch, port })
console.log(`echo-daemon listening on :${port}`)
