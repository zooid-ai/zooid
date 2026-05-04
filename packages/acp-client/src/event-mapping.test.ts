import { describe, it, expect } from 'vitest'
import {
  acpUpdateToAgentEvent,
  approvalDecisionToPermissionResponse,
} from './event-mapping.js'
import type { AgentEvent } from './types.js'

describe('acpUpdateToAgentEvent', () => {
  it('maps agent_message_chunk to message_chunk event', () => {
    const event = acpUpdateToAgentEvent({
      sessionId: 's-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      },
    })
    expect(event).toEqual<AgentEvent>({
      type: 'message_chunk',
      sessionId: 's-1',
      content: { type: 'text', text: 'hello' },
    })
  })

  it('maps tool_call to tool_call event with id, title, kind, status', () => {
    const event = acpUpdateToAgentEvent({
      sessionId: 's-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-7',
        title: 'Reading auth.ts',
        kind: 'read',
        status: 'pending',
      },
    })
    expect(event).toEqual<AgentEvent>({
      type: 'tool_call',
      sessionId: 's-1',
      toolCallId: 'tc-7',
      title: 'Reading auth.ts',
      kind: 'read',
      status: 'pending',
    })
  })

  it('maps tool_call_update with diff content', () => {
    const event = acpUpdateToAgentEvent({
      sessionId: 's-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-7',
        status: 'completed',
        content: [{ type: 'diff', path: '/abs/auth.ts', oldText: 'a', newText: 'b' }],
      },
    })
    expect(event).toEqual<AgentEvent>({
      type: 'tool_call_update',
      sessionId: 's-1',
      toolCallId: 'tc-7',
      status: 'completed',
      kind: undefined,
      content: [{ type: 'diff', path: '/abs/auth.ts', oldText: 'a', newText: 'b' }],
    })
  })

  it('maps plan update', () => {
    const event = acpUpdateToAgentEvent({
      sessionId: 's-1',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'Step 1', priority: 'high', status: 'pending' }],
      },
    })
    expect(event?.type).toBe('plan')
    if (event?.type === 'plan') {
      expect(event.entries).toHaveLength(1)
      expect(event.entries[0].content).toBe('Step 1')
    }
  })

  it('returns null for unknown update variants (forward-compat)', () => {
    const event = acpUpdateToAgentEvent({
      sessionId: 's-1',
      // @ts-expect-error — exercising unknown variant
      update: { sessionUpdate: 'something_new', foo: 'bar' },
    })
    expect(event).toBeNull()
  })
})

describe('approvalDecisionToPermissionResponse', () => {
  it('maps an allow decision to a selected outcome with the chosen optionId', () => {
    const res = approvalDecisionToPermissionResponse({
      decision: 'allow',
      optionId: 'allow-once',
    })
    expect(res).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    })
  })

  it('maps a cancel decision to a cancelled outcome', () => {
    const res = approvalDecisionToPermissionResponse({ decision: 'cancel' })
    expect(res).toEqual({ outcome: { outcome: 'cancelled' } })
  })
})
