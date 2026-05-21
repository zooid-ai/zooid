import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { AcpAgentRegistry } from '@zooid/core'
import type { AgentEvent } from '@zooid/acp-client'
import { LocalAcpRuntime } from '../../src/index.js'

const fixturePath = fileURLToPath(
  new URL('../../../acp-client/test/fixtures/echo-agent.ts', import.meta.url),
)

describe('AcpAgentRegistry + LocalAcpRuntime against echo fixture', () => {
  it('drives a prompt end-to-end, surfaces an agent_message_chunk, resolves an approval', async () => {
    const events: AgentEvent[] = []
    let approvalSeen = false
    const reg = new AcpAgentRegistry({
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
    reg.onEvent = (_name, e) => {
      events.push(e)
    }
    reg.onApprovalRequest = async () => {
      approvalSeen = true
      return { decision: 'allow', optionId: 'allow-once' }
    }

    try {
      const result = await reg.prompt('echo', {
        threadId: 'thread-1',
        content: [{ type: 'text', text: 'hello' }],
      })
      expect(result.stopReason).toBe('end_turn')
      expect(approvalSeen).toBe(true)
      expect(events.some((e) => e.type === 'agent_message_chunk')).toBe(true)
    } finally {
      await reg.stopAll()
    }
  }, 15_000)
})
