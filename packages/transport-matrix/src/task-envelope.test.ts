import { describe, it, expect } from 'vitest'
import { renderAssigneeEnvelope, renderDelivery } from './task-dispatch.js'

describe('renderAssigneeEnvelope', () => {
  it('names the caller, the owed result, and the depth cap', () => {
    const out = renderAssigneeEnvelope({
      parentAgent: 'zooid-assistant',
      prompt: 'Write a one-sentence bug report.',
    })
    expect(out).toMatch(/^\[task\] from zooid-assistant/)
    expect(out).toMatch(/zooid_complete_task/)
    expect(out).toMatch(/ending your turn without one/i)
    expect(out).toMatch(/@mention/)
    expect(out.endsWith('Write a one-sentence bug report.')).toBe(true)
  })
})

describe('renderDelivery', () => {
  it('tells a notify:caller supervisor to stop and wait', () => {
    expect(renderDelivery('caller')).toMatch(/new turn/)
    expect(renderDelivery('caller')).toMatch(/do not read the task thread/i)
  })
  it('tells a notify:none supervisor the thread is the result surface', () => {
    expect(renderDelivery('none')).toMatch(/no result returns/i)
    expect(renderDelivery('none')).not.toMatch(/new turn/)
  })
})
