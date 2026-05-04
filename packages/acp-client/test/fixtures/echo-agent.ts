// Fixture ACP agent. Behavior:
// - initialize: reports protocolVersion 1 and minimal capabilities.
// - newSession: returns a session id derived from the cwd.
// - prompt: emits one agent_message_chunk, then a session/request_permission,
//   then completes with stopReason "end_turn" once permission is granted.
//
// Run via: node --import tsx packages/acp-client/test/fixtures/echo-agent.ts
import { Readable, Writable } from 'node:stream'
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>
const stream = ndJsonStream(output, input)

const conn = new AgentSideConnection(
  (client) => ({
    async initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
        agentInfo: { name: 'echo-agent', title: 'Echo', version: '0.0.0' },
        authMethods: [],
      }
    },

    async newSession({ cwd }) {
      return { sessionId: `echo-${Buffer.from(cwd).toString('hex').slice(0, 8)}` }
    },

    async authenticate() {
      return {}
    },

    async cancel() {
      // no-op
    },

    async prompt({ sessionId }) {
      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'echo: hi' },
        },
      })

      const decision = await client.requestPermission({
        sessionId,
        toolCall: { toolCallId: 'tc-fixture' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
      })

      if (decision.outcome.outcome === 'cancelled') {
        return { stopReason: 'cancelled' }
      }
      if (decision.outcome.optionId === 'reject-once') {
        return { stopReason: 'refusal' }
      }
      return { stopReason: 'end_turn' }
    },
  }),
  stream,
)

await conn.closed
