import type { ThreadCompletion } from '@zooid/core'

/** ACP's stable prompt termination values (kept local to avoid an SDK runtime dep). */
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

export interface CompletionInputs {
  agent: string
  threadId: string
  stopReason?: StopReason
  error?: unknown
  summary?: string
  prose?: string
  outstanding: number
  awaitingHuman: number
}
export type CompletionDecision =
  | { decision: 'stay_open'; reason: 'outstanding_handoff' | 'awaiting_human' }
  | { decision: 'finish'; completion: ThreadCompletion }

export function evaluateCompletion(input: CompletionInputs): CompletionDecision {
  const prose = input.prose?.trim()
  const output = prose ? { type: 'message' as const, text: prose } : undefined
  const finish = (completion: Omit<ThreadCompletion, 'agent' | 'thread_id'>): CompletionDecision => ({
    decision: 'finish', completion: { agent: input.agent, thread_id: input.threadId, ...completion },
  })
  if (input.error !== undefined)
    return finish({ status: 'failed', error: input.error instanceof Error ? input.error.message : String(input.error), ...(output ? { output } : {}) })
  if (input.stopReason === 'cancelled') return finish({ status: 'cancelled', ...(output ? { output } : {}) })
  if (input.stopReason === 'max_tokens' || input.stopReason === 'max_turn_requests')
    return finish({ status: 'partial', reason: input.stopReason, ...(output ? { output } : {}) })
  if (input.stopReason === 'refusal') return finish({ status: 'failed', reason: 'refusal', ...(output ? { output } : {}) })
  if (input.awaitingHuman > 0) return { decision: 'stay_open', reason: 'awaiting_human' }
  if (input.outstanding > 0) return { decision: 'stay_open', reason: 'outstanding_handoff' }
  if (input.summary) return finish({ status: 'complete', output: { type: 'message', text: input.summary } })
  if (output) return finish({ status: 'complete', output })
  return finish({ status: 'failed', reason: 'no_result', error: 'No result produced' })
}
