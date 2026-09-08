import { describe, expect, it } from 'vitest'
import { evaluateCompletion } from './task-completion.js'

const base = { agent: 'worker', threadId: '$root', outstanding: 0, awaitingHuman: 0 } as const

describe('evaluateCompletion', () => {
  it('uses a summary only after all work has returned', () => {
    expect(evaluateCompletion({ ...base, stopReason: 'end_turn', summary: 'done', outstanding: 1 }))
      .toEqual({ decision: 'stay_open', reason: 'outstanding_handoff' })
    expect(evaluateCompletion({ ...base, stopReason: 'end_turn', summary: 'done' }))
      .toMatchObject({ decision: 'finish', completion: { status: 'complete', output: { text: 'done' } } })
  })
  it('makes cancellation and limits terminal even with outstanding work', () => {
    expect(evaluateCompletion({ ...base, stopReason: 'cancelled', outstanding: 1 }))
      .toMatchObject({ decision: 'finish', completion: { status: 'cancelled' } })
    expect(evaluateCompletion({ ...base, stopReason: 'max_tokens', outstanding: 1 }))
      .toMatchObject({ decision: 'finish', completion: { status: 'partial', reason: 'max_tokens' } })
  })
  it('does not report an empty successful result', () => {
    expect(evaluateCompletion({ ...base, stopReason: 'end_turn' }))
      .toMatchObject({ decision: 'finish', completion: { status: 'failed', reason: 'no_result' } })
  })
})
