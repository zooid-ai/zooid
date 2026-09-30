// Fixture ACP agent for elicitation. Prompt text selects the scenario:
//   caps        → replies with the client's advertised clientCapabilities (JSON)
//   ask         → one session-scoped form elicitation (toolCallId tc1); replies
//                 `answer:<json>` or `error:<code>`
//   ask-twice   → two concurrent elicitations (tcA, tcB); replies `answers:<json>`
//   ask-cancel  → elicitation with a cancellationSignal aborted after 200ms
//                 (sends $/cancel_request); replies `cancelled:<code>`
//   ask-url     → url-mode elicitation; replies `error:<code>`
//   ask-exit    → sends an elicitation, then exits the process after 200ms
//
// Run via: node --import tsx packages/acp-client/test/fixtures/ask-agent.ts
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
)

const schema = {
  type: 'object' as const,
  properties: { env: { type: 'string' as const, enum: ['staging', 'prod'] } },
  required: ['env'],
}
let clientCaps: unknown = null
let seq = 0

type Ctx = acp.AgentContext

async function say(client: Ctx, sessionId: string, text: string): Promise<void> {
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  })
}

function ask(client: Ctx, sessionId: string, toolCallId: string, signal?: AbortSignal) {
  return client.request(
    acp.methods.client.elicitation.create,
    { mode: 'form', sessionId, toolCallId, message: `q-${toolCallId}`, requestedSchema: schema },
    signal ? { cancellationSignal: signal } : undefined,
  )
}

const code = (e: unknown) => (e as { code?: number }).code ?? 'none'

const conn = acp
  .agent({ name: 'ask-agent' })
  .onRequest(acp.methods.agent.initialize, (ctx) => {
    clientCaps = ctx.params.clientCapabilities ?? null
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      authMethods: [],
    }
  })
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: `ask-${++seq}` }))
  .onNotification(acp.methods.agent.session.cancel, () => {})
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const { sessionId } = ctx.params
    const first = ctx.params.prompt[0] as { type: string; text?: string } | undefined
    const text = first?.type === 'text' ? (first.text ?? '') : ''
    const client = ctx.client
    switch (text) {
      case 'caps':
        await say(client, sessionId, JSON.stringify(clientCaps))
        return { stopReason: 'end_turn' as const }
      case 'ask':
        try {
          await say(client, sessionId, `answer:${JSON.stringify(await ask(client, sessionId, 'tc1'))}`)
        } catch (e) {
          await say(client, sessionId, `error:${code(e)}`)
        }
        return { stopReason: 'end_turn' as const }
      case 'ask-twice': {
        const answers = await Promise.all([ask(client, sessionId, 'tcA'), ask(client, sessionId, 'tcB')])
        await say(client, sessionId, `answers:${JSON.stringify(answers)}`)
        return { stopReason: 'end_turn' as const }
      }
      case 'ask-cancel': {
        const c = new AbortController()
        const p = ask(client, sessionId, 'tcX', c.signal)
        setTimeout(() => c.abort(), 200)
        try {
          await p
          await say(client, sessionId, 'unexpected-answer')
        } catch (e) {
          await say(client, sessionId, `cancelled:${code(e)}`)
        }
        return { stopReason: 'cancelled' as const }
      }
      case 'ask-url':
        try {
          await client.request(acp.methods.client.elicitation.create, {
            mode: 'url', sessionId, message: 'm', url: 'https://example.com', elicitationId: 'u1',
          })
        } catch (e) {
          await say(client, sessionId, `error:${code(e)}`)
        }
        return { stopReason: 'end_turn' as const }
      case 'ask-exit':
        void ask(client, sessionId, 'tcE').catch(() => {})
        setTimeout(() => process.exit(0), 200)
        return new Promise<never>(() => {})
    }
    return { stopReason: 'end_turn' as const }
  })
  .connect(stream)

await conn.closed
