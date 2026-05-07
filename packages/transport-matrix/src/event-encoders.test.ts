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
