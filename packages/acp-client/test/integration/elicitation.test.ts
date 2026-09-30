import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { AcpClient, ElicitationUnsupportedError } from '../../src/index.js'
import type { AgentEvent, ElicitationRequest, ElicitationResponse } from '../../src/index.js'

const fixturePath = fileURLToPath(new URL('../fixtures/ask-agent.ts', import.meta.url))

type Handler = (req: ElicitationRequest, signal: AbortSignal) => Promise<ElicitationResponse>

function makeClient(onElicitationRequest?: Handler) {
  const events: AgentEvent[] = []
  const client = new AcpClient({
    agent: { id: 'ask', command: process.execPath, args: ['--import', 'tsx', fixturePath] },
    onEvent: (e) => events.push(e),
    onApprovalRequest: async () => ({ decision: 'cancel' }),
    ...(onElicitationRequest ? { onElicitationRequest } : {}),
  })
  const text = () =>
    events
      .filter((e) => e.type === 'agent_message_chunk')
      .map((e) => (e as { content: { text?: string } }).content.text ?? '')
      .join('')
  return { client, text }
}

const prompt = (client: AcpClient, text: string, threadId = 't1') =>
  client.prompt({ threadId, content: [{ type: 'text', text }] })

async function waitFor(cond: () => boolean, timeoutMs = 5000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('AcpClient elicitation (fixture agent, SDK 1.5)', () => {
  it('advertises elicitation.form only when a handler is installed', async () => {
    const withH = makeClient(async () => ({ action: 'decline' }))
    await withH.client.start()
    await prompt(withH.client, 'caps')
    const caps = JSON.parse(withH.text())
    expect(caps.elicitation).toEqual({ form: {} })
    expect(caps.elicitation.url).toBeUndefined()
    expect(caps.fs).toEqual({ readTextFile: false, writeTextFile: false })
    await withH.client.stop()

    const without = makeClient()
    await without.client.start()
    await prompt(without.client, 'caps')
    expect(JSON.parse(without.text()).elicitation ?? null).toBeNull()
    await without.client.stop()
  })

  it('round-trips an accepted answer back into the same turn', async () => {
    const seen: ElicitationRequest[] = []
    const { client, text } = makeClient(async (req) => {
      seen.push(req)
      // A human wait: no application timeout applies.
      await new Promise((r) => setTimeout(r, 1500))
      return { action: 'accept', content: { env: 'prod' } }
    })
    await client.start()
    const result = await prompt(client, 'ask')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ toolCallId: 'tc1', message: 'q-tc1' })
    expect(seen[0]!.sessionId).toMatch(/^ask-/)
    expect(seen[0]!.requestedSchema).toMatchObject({ required: ['env'] })
    expect(text()).toBe('answer:{"action":"accept","content":{"env":"prod"}}')
    expect(result.stopReason).toBe('end_turn')
    await client.stop()
  }, 15_000)

  it('keeps concurrent requests independent', async () => {
    const pending = new Map<string, (r: ElicitationResponse) => void>()
    const { client, text } = makeClient(
      (req) => new Promise((resolve) => pending.set(req.toolCallId!, resolve)),
    )
    await client.start()
    const done = prompt(client, 'ask-twice')
    await waitFor(() => pending.size === 2)
    pending.get('tcB')!({ action: 'accept', content: { env: 'staging' } })
    pending.get('tcA')!({ action: 'decline' })
    await done
    expect(JSON.parse(text().replace(/^answers:/, ''))).toEqual([
      { action: 'decline' },
      { action: 'accept', content: { env: 'staging' } },
    ])
    await client.stop()
  }, 15_000)

  it('aborts the handler signal on $/cancel_request', async () => {
    let aborted = false
    const { client, text } = makeClient(
      (_req, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true
            resolve({ action: 'cancel' })
          })
        }),
    )
    await client.start()
    await prompt(client, 'ask-cancel')
    expect(aborted).toBe(true)
    expect(text()).toMatch(/^cancelled:/)
    await client.stop()
  }, 15_000)

  it('rejects url mode with -32602 without calling the handler', async () => {
    let called = false
    const { client, text } = makeClient(async () => {
      called = true
      return { action: 'decline' }
    })
    await client.start()
    await prompt(client, 'ask-url')
    expect(called).toBe(false)
    expect(text()).toBe('error:-32602')
    await client.stop()
  }, 15_000)

  it('maps ElicitationUnsupportedError from the handler to -32602', async () => {
    const { client, text } = makeClient(async () => {
      throw new ElicitationUnsupportedError('no destination')
    })
    await client.start()
    await prompt(client, 'ask')
    expect(text()).toBe('error:-32602')
    await client.stop()
  }, 15_000)

  it('aborts pending handler signals when the adapter exits', async () => {
    let signal: AbortSignal | undefined
    const { client } = makeClient((_req, s) => {
      signal = s
      return new Promise(() => {})
    })
    await client.start()
    void prompt(client, 'ask-exit').catch(() => {})
    await waitFor(() => signal !== undefined)
    await waitFor(() => signal!.aborted === true)
    await client.stop()
  }, 15_000)

  it('aborts pending handler signals on stop()', async () => {
    let signal: AbortSignal | undefined
    const { client } = makeClient((_req, s) => {
      signal = s
      return new Promise(() => {})
    })
    await client.start()
    void prompt(client, 'ask').catch(() => {})
    await waitFor(() => signal !== undefined)
    await client.stop()
    await waitFor(() => signal!.aborted === true)
  }, 15_000)
})
