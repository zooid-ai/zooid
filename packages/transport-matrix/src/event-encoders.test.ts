import { describe, it, expect } from 'vitest'
import type {
  ToolCallEvent,
  ToolCallUpdateEvent,
  PlanEvent,
} from '@zooid/acp-client'
import {
  toToolCallBody,
  toUpdateBody,
  toPlanBody,
  toErrorBody,
  toAvailableCommandsBody,
  toTurnEndBody,
} from './event-encoders.js'

describe('toToolCallBody', () => {
  it('maps required + optional fields with snake_case keys', () => {
    const evt: ToolCallEvent = {
      type: 'tool_call',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      title: 'Run tests',
      kind: 'execute',
      status: 'pending',
    }
    expect(toToolCallBody(evt)).toEqual({
      session_id: 'sess-1',
      tool_call_id: 'tc-1',
      title: 'Run tests',
      kind: 'execute',
      status: 'pending',
    })
  })

  it('omits optional fields when undefined', () => {
    const evt: ToolCallEvent = {
      type: 'tool_call',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      title: 'Run tests',
    }
    expect(toToolCallBody(evt)).toEqual({
      session_id: 'sess-1',
      tool_call_id: 'tc-1',
      title: 'Run tests',
    })
  })

  it('forwards rawInput as raw_input (snake_case) and locations', () => {
    const evt: ToolCallEvent = {
      type: 'tool_call',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      title: 'Read file',
      kind: 'read',
      rawInput: { filepath: '/abs/path/notes.md' },
      locations: [{ path: '/abs/path/notes.md' }],
    }
    expect(toToolCallBody(evt)).toEqual({
      session_id: 'sess-1',
      tool_call_id: 'tc-1',
      title: 'Read file',
      kind: 'read',
      raw_input: { filepath: '/abs/path/notes.md' },
      locations: [{ path: '/abs/path/notes.md' }],
    })
  })

  it('truncates long string values inside rawInput', () => {
    const longDiff = 'a'.repeat(500)
    const evt: ToolCallEvent = {
      type: 'tool_call',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      title: 'Edit file',
      kind: 'edit',
      rawInput: { filepath: '/abs/short.md', diff: longDiff },
    }
    const body = toToolCallBody(evt) as { raw_input: Record<string, unknown> }
    expect(body.raw_input.filepath).toBe('/abs/short.md')
    expect(body.raw_input.diff).toBe('a'.repeat(250) + '… [truncated]')
  })
})

describe('toUpdateBody', () => {
  it('passes through status/kind/content with snake_case keys', () => {
    const evt: ToolCallUpdateEvent = {
      type: 'tool_call_update',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'done' } }] as never,
    }
    expect(toUpdateBody(evt)).toEqual({
      session_id: 'sess-1',
      tool_call_id: 'tc-1',
      status: 'completed',
      content: evt.content,
    })
  })

  it('omits absent optional fields', () => {
    const evt: ToolCallUpdateEvent = {
      type: 'tool_call_update',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
    }
    expect(toUpdateBody(evt)).toEqual({
      session_id: 'sess-1',
      tool_call_id: 'tc-1',
    })
  })
})

describe('toPlanBody', () => {
  it('forwards entries verbatim under session_id', () => {
    const evt: PlanEvent = {
      type: 'plan',
      sessionId: 'sess-1',
      entries: [{ content: 'step a', priority: 'high', status: 'pending' }] as never,
    }
    expect(toPlanBody(evt)).toEqual({
      session_id: 'sess-1',
      entries: evt.entries,
    })
  })
})

describe('toAvailableCommandsBody', () => {
  it('encodes available_commands into the body ZNC021 decodes', () => {
    expect(
      toAvailableCommandsBody({
        type: 'available_commands',
        sessionId: 's-1',
        commands: [
          { name: 'plan', description: 'Switch to plan mode' },
          { name: 'compact', description: 'Compact the context' },
        ],
      }),
    ).toEqual({
      session_id: 's-1',
      available_commands: [
        { name: 'plan', description: 'Switch to plan mode' },
        { name: 'compact', description: 'Compact the context' },
      ],
    })
  })
})

describe('toErrorBody', () => {
  const threadRoot = '$root-event-id'

  it('encodes a full error TapEvent including acp_error and recovery URL', () => {
    const body = toErrorBody(
      {
        kind: 'error',
        agentId: 'alice',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        code: 'auth_missing',
        message: 'Authentication required',
        detail: 'claude-agent-acp returned RequestError on session/prompt',
        transient: false,
        acp_error: { code: -32000, message: 'Authentication required' },
      },
      threadRoot,
    )
    expect(body).toMatchObject({
      msgtype: 'm.notice',
      body: '⚠ [auth_missing] Authentication required',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      code: 'auth_missing',
      message: 'Authentication required',
      detail: 'claude-agent-acp returned RequestError on session/prompt',
      transient: false,
      acp_error: { code: -32000, message: 'Authentication required' },
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root-event-id' },
    })
    expect(body.recovery).toMatch(/^https:\/\/zooid\.dev\/docs\//)
  })

  it('truncates message to 250 chars and detail to 2000 chars', () => {
    const body = toErrorBody(
      {
        kind: 'error',
        agentId: 'a',
        sessionId: 's',
        turnId: 't',
        code: 'internal',
        message: 'x'.repeat(500),
        detail: 'y'.repeat(5000),
        transient: false,
      },
      threadRoot,
    )
    expect((body.message as string).length).toBe(250)
    expect((body.detail as string).length).toBe(2000)
  })

  it('omits turn_id when null and omits acp_error when undefined', () => {
    const body = toErrorBody(
      {
        kind: 'error',
        agentId: 'a',
        sessionId: 's',
        turnId: null,
        code: 'container_exit',
        message: 'Container exited',
        transient: true,
      },
      threadRoot,
    )
    expect(body.turn_id).toBeUndefined()
    expect(body.acp_error).toBeUndefined()
  })

  it('omits session_id when null (failure preceded session/new)', () => {
    const body = toErrorBody(
      {
        kind: 'error',
        agentId: 'a',
        sessionId: null,
        turnId: null,
        code: 'image_pull_failed',
        message: 'pull failed',
        transient: true,
      },
      threadRoot,
    )
    expect(body.session_id).toBeUndefined()
  })
})

describe('toTurnEndBody', () => {
  it('carries the produced_output flag ZOD076 reads', () => {
    expect(toTurnEndBody({ agentId: 'claude', sessionId: 's1', producedOutput: true }, '$root')).toEqual({
      body: 'claude finished',
      agent_id: 'claude',
      session_id: 's1',
      produced_output: true,
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
    })
  })

  it('marks an empty turn', () => {
    const out = toTurnEndBody(
      { agentId: 'claude', sessionId: 's1', producedOutput: false },
      '$root',
    )
    expect(out.produced_output).toBe(false)
    expect(out.body).toBe('claude finished without output')
  })

  it('carries no msgtype — a vestigial m.notice here would collide with .m.rule.suppress_notices', () => {
    const out = toTurnEndBody({ agentId: 'a', sessionId: 's', producedOutput: true }, '$r')
    expect(out).not.toHaveProperty('msgtype')
  })
})
