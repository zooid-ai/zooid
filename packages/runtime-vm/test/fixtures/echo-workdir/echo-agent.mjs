#!/usr/bin/env node
// Zero-dependency ACP echo agent for the vm runtime's tests. It runs in a stock
// node image with no node_modules and no network, so it speaks NDJSON JSON-RPC
// by hand instead of importing @agentclientprotocol/sdk.
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
let sessions = 0

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  // Notifications and responses to our own requests need no reply.
  if (msg.id === undefined || !msg.method) return
  switch (msg.method) {
    case 'initialize':
      return send({
        id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] },
      })
    case 'session/new':
      return send({ id: msg.id, result: { sessionId: `vm-echo-${++sessions}` } })
    case 'session/prompt': {
      const text = msg.params.prompt.find((p) => p.type === 'text')?.text ?? ''
      let workdir = 'workdir writable'
      try {
        writeFileSync('.zooid-vm-probe', 'x')
      } catch {
        workdir = 'workdir read-only'
      }
      send({
        method: 'session/update',
        params: {
          sessionId: msg.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `echo: ${text} (cwd ${process.cwd()}, ${workdir})` },
          },
        },
      })
      return send({ id: msg.id, result: { stopReason: 'end_turn' } })
    }
    default:
      return send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
  }
})
