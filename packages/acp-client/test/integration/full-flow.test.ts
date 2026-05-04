import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { AcpClient } from '../../src/index.js'
import type { AgentEvent } from '../../src/index.js'

const fixturePath = fileURLToPath(
  new URL('../fixtures/echo-agent.ts', import.meta.url),
)

describe('AcpClient end-to-end with echo fixture', () => {
  it('initializes, prompts, streams an event, and resolves a permission request', async () => {
    const events: AgentEvent[] = []
    let approvalReceived: { tool: string; resolve: (allow: boolean) => void } | null = null

    const client = new AcpClient({
      agent: {
        id: 'echo',
        command: process.execPath, // node
        args: ['--import', 'tsx', fixturePath],
      },
      onEvent: (e) => {
        events.push(e)
      },
      onApprovalRequest: (req) =>
        new Promise((resolve) => {
          approvalReceived = {
            tool: req.toolCallId,
            resolve: (allow) =>
              resolve(
                allow
                  ? { decision: 'allow', optionId: 'allow-once' }
                  : { decision: 'cancel' },
              ),
          }
        }),
    })

    await client.start()

    const promptPromise = client.prompt({
      threadId: 'thread-1',
      content: [{ type: 'text', text: 'hello' }],
    })

    await waitFor(() => approvalReceived !== null)
    expect(approvalReceived!.tool).toBe('tc-fixture')

    approvalReceived!.resolve(true)

    const result = await promptPromise
    expect(result.stopReason).toBe('end_turn')

    expect(events.some((e) => e.type === 'message_chunk')).toBe(true)

    await client.stop()
  }, 15_000)
})

async function waitFor(cond: () => boolean, timeoutMs = 5000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}
