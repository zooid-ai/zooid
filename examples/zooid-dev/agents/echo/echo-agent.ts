#!/usr/bin/env -S node --import tsx
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
        agentInfo: { name: 'echo', title: 'Echo agent', version: '0.0.0' },
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
    async prompt({ sessionId, prompt }) {
      const text = prompt.find((p) => p.type === 'text')?.text ?? ''
      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `echo: ${text}` },
        },
      })
      return { stopReason: 'end_turn' }
    },
  }),
  stream,
)

await conn.closed
