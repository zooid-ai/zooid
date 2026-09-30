import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { ElicitationRequest, ElicitationResponse, ElicitationSchema } from '@zooid/acp-client'
import type { PendingInputRegistry } from './task-actions.js'

export type ElicitationStatus = 'accepted' | 'declined' | 'cancelled' | 'interrupted'

export interface PendingElicitation {
  /** Zooid's id — distinct from the JSON-RPC id and the tool-call id. */
  requestId: string
  agentName: string
  sessionId: string
  /** Turn-queue key ([[ZOD071]] arc or thread root); what ZOD072 counts. */
  sessionKey: string
  roomId: string
  threadRoot: string
  toolCallId?: string
  message: string
  requestedSchema: ElicitationSchema
  meta?: Record<string, unknown>
  /** Set once the request card is published. */
  requestEventId?: string
  state: 'pending' | ElicitationStatus
}

export interface ElicitationResolution {
  record: PendingElicitation
  status: ElicitationStatus
  respondedBy?: string
  responseEventId?: string
  reason?: string
  content?: Extract<ElicitationResponse, { action: 'accept' }>['content']
}

export interface RegisterElicitationInput {
  agentName: string
  sessionId: string
  sessionKey: string
  roomId: string
  threadRoot: string
  request: ElicitationRequest
  signal: AbortSignal
}

interface Entry {
  record: PendingElicitation
  resolve(r: ElicitationResponse): void
  reject(e: Error): void
  detach(): void
}

const STATUS: Record<ElicitationResponse['action'], ElicitationStatus> = {
  accept: 'accepted',
  decline: 'declined',
  cancel: 'cancelled',
}

/**
 * Pending human-input requests (ACP form elicitations). Separate from
 * ApprovalCorrelator on purpose: a form answer is not a permission decision.
 * Every transition out of `pending` is atomic and happens once; everything
 * after the first is a no-op returning false. Emits `'resolved'` for every
 * terminal transition except `fail` (a card that was never shown).
 *
 * Also the ZOD072 PendingInputRegistry: countFor/cancelFor by session key.
 */
export class ElicitationCorrelator extends EventEmitter implements PendingInputRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly terminalOrder: string[] = []
  private readonly terminalCap: number

  constructor(opts: { terminalCap?: number } = {}) {
    super()
    this.terminalCap = opts.terminalCap ?? 500
  }

  register(input: RegisterElicitationInput): { record: PendingElicitation; response: Promise<ElicitationResponse> } {
    const requestId = randomUUID()
    let resolve!: (r: ElicitationResponse) => void
    let reject!: (e: Error) => void
    const response = new Promise<ElicitationResponse>((res, rej) => {
      resolve = res
      reject = rej
    })
    const { request } = input
    const record: PendingElicitation = {
      requestId,
      agentName: input.agentName,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      roomId: input.roomId,
      threadRoot: input.threadRoot,
      ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      message: request.message,
      requestedSchema: structuredClone(request.requestedSchema),
      ...(request.meta ? { meta: request.meta } : {}),
      state: 'pending',
    }
    const onAbort = () => this.cancel(requestId, 'agent_cancelled')
    this.entries.set(requestId, {
      record,
      resolve,
      reject,
      detach: () => input.signal.removeEventListener('abort', onAbort),
    })
    if (input.signal.aborted) onAbort()
    else input.signal.addEventListener('abort', onAbort, { once: true })
    return { record: { ...record }, response }
  }

  get(requestId: string): PendingElicitation | undefined {
    const e = this.entries.get(requestId)
    return e ? { ...e.record } : undefined
  }

  attachRequestEvent(requestId: string, eventId: string): void {
    const e = this.entries.get(requestId)
    if (e) e.record.requestEventId = eventId
  }

  settle(
    requestId: string,
    response: ElicitationResponse,
    by: { respondedBy?: string; responseEventId?: string } = {},
  ): boolean {
    const e = this.pending(requestId)
    if (!e) return false
    const status = STATUS[response.action]
    this.finish(e, status)
    e.resolve(response)
    this.emit('resolved', {
      record: { ...e.record },
      status,
      ...(response.action === 'accept' ? { content: response.content } : {}),
      ...(by.respondedBy ? { respondedBy: by.respondedBy } : {}),
      ...(by.responseEventId ? { responseEventId: by.responseEventId } : {}),
    } satisfies ElicitationResolution)
    return true
  }

  cancel(requestId: string, reason: string): boolean {
    const e = this.pending(requestId)
    if (!e) return false
    this.finish(e, 'cancelled')
    e.resolve({ action: 'cancel' })
    this.emit('resolved', { record: { ...e.record }, status: 'cancelled', reason } satisfies ElicitationResolution)
    return true
  }

  /** The card could not be shown: reject the ACP call, emit nothing. */
  fail(requestId: string, err: Error): boolean {
    const e = this.pending(requestId)
    if (!e) return false
    this.finish(e, 'cancelled')
    e.reject(err)
    return true
  }

  cancelSession(sessionId: string, reason: string): number {
    let n = 0
    for (const e of [...this.entries.values()]) {
      if (e.record.sessionId === sessionId && this.cancel(e.record.requestId, reason)) n++
    }
    return n
  }

  countForSession(sessionId: string): number {
    return this.count((r) => r.sessionId === sessionId)
  }

  countFor(sessionKey: string): number {
    return this.count((r) => r.sessionKey === sessionKey)
  }

  cancelFor(sessionKeys: string[]): void {
    const keys = new Set(sessionKeys)
    for (const e of [...this.entries.values()]) {
      if (keys.has(e.record.sessionKey)) this.cancel(e.record.requestId, 'task_closed')
    }
  }

  private count(match: (r: PendingElicitation) => boolean): number {
    let n = 0
    for (const e of this.entries.values()) if (e.record.state === 'pending' && match(e.record)) n++
    return n
  }

  private pending(requestId: string): Entry | undefined {
    const e = this.entries.get(requestId)
    return e && e.record.state === 'pending' ? e : undefined
  }

  private finish(e: Entry, status: ElicitationStatus): void {
    e.record.state = status
    e.detach()
    // Terminal records stay (bounded) so a late answer gets stale feedback.
    this.terminalOrder.push(e.record.requestId)
    while (this.terminalOrder.length > this.terminalCap) {
      this.entries.delete(this.terminalOrder.shift()!)
    }
  }
}
