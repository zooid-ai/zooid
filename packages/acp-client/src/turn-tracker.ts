import type { SessionNotification } from '@agentclientprotocol/sdk'

export type SessionUpdate = SessionNotification['update']

export type TapEvent =
  | {
      kind: 'turn_started'
      agentId: string
      sessionId: string
      turnId: string
      promptText: string
    }
  | {
      kind: 'session_update'
      agentId: string
      sessionId: string
      turnId: string | null
      update: SessionUpdate
    }
  | {
      kind: 'turn_completed'
      agentId: string
      sessionId: string
      turnId: string
      stopReason: string
    }

export interface TurnTrackerOpts {
  agentId: string
  onTap: (e: TapEvent) => void
  /** Override for tests; defaults to crypto.randomUUID(). */
  newTurnId?: () => string
}

export class TurnTracker {
  private readonly active = new Map<string, string>()
  private readonly newTurnId: () => string
  private readonly agentId: string
  private readonly onTap: (e: TapEvent) => void

  constructor(opts: TurnTrackerOpts) {
    this.agentId = opts.agentId
    this.onTap = opts.onTap
    this.newTurnId =
      opts.newTurnId ?? (() => `turn_${crypto.randomUUID().slice(0, 8)}`)
  }

  startTurn({
    sessionId,
    promptText,
  }: {
    sessionId: string
    promptText: string
  }): string {
    const turnId = this.newTurnId()
    this.active.set(sessionId, turnId)
    this.onTap({
      kind: 'turn_started',
      agentId: this.agentId,
      sessionId,
      turnId,
      promptText,
    })
    return turnId
  }

  observeUpdate(sessionId: string, update: SessionUpdate): void {
    const turnId = this.active.get(sessionId) ?? null
    this.onTap({
      kind: 'session_update',
      agentId: this.agentId,
      sessionId,
      turnId,
      update,
    })
  }

  endTurn({
    sessionId,
    stopReason,
  }: {
    sessionId: string
    stopReason: string
  }): void {
    const turnId = this.active.get(sessionId)
    if (!turnId) return
    this.active.delete(sessionId)
    this.onTap({
      kind: 'turn_completed',
      agentId: this.agentId,
      sessionId,
      turnId,
      stopReason,
    })
  }
}
