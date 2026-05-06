import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  ApprovalDecision,
  ApprovalRequest,
} from '@zooid/acp-client'

export interface RegisteredApproval {
  approvalId: string
  agentName: string
  sessionId: string
  toolCallId: string
  toolKind?: string
  toolTitle?: string
  toolInput?: unknown
  options: ApprovalRequest['options']
  decisionPromise: Promise<ApprovalDecision>
}

export interface RegisterOptions {
  /** Wall-clock timeout in ms. 0 = no timeout. */
  timeoutMs?: number
}

interface PendingEntry extends RegisteredApproval {
  resolve(decision: ApprovalDecision): void
  timer?: ReturnType<typeof setTimeout>
}

/**
 * Correlates ACP approval requests (mid-prompt, originating in `AcpClient`)
 * with HTTP/transport-side decisions. The transport listens to:
 *
 *   - `'registered'` — fires after `register()` so the transport can emit
 *     `approval.request` on the right SSE stream.
 *   - `'timeout'`    — fires when an entry is auto-cancelled by the timer
 *     so the transport can emit `approval.timeout`.
 */
export class ApprovalCorrelator extends EventEmitter {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly bySession = new Map<string, Set<string>>()

  register(
    agentName: string,
    sessionId: string,
    req: ApprovalRequest,
    opts: RegisterOptions = {},
  ): RegisteredApproval {
    const approvalId = randomUUID()
    let resolve!: (d: ApprovalDecision) => void
    const decisionPromise = new Promise<ApprovalDecision>((r) => {
      resolve = r
    })
    const entry: PendingEntry = {
      approvalId,
      agentName,
      sessionId,
      toolCallId: req.toolCallId,
      toolKind: req.toolKind,
      toolTitle: req.toolTitle,
      toolInput: req.toolInput,
      options: req.options,
      decisionPromise,
      resolve,
    }
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        if (this.pending.get(approvalId) !== entry) return
        entry.resolve({ decision: 'cancel' })
        this.pending.delete(approvalId)
        this.bySession.get(sessionId)?.delete(approvalId)
        this.emit('timeout', { approvalId, sessionId, agentName })
      }, opts.timeoutMs)
      entry.timer.unref?.()
    }
    this.pending.set(approvalId, entry)
    let set = this.bySession.get(sessionId)
    if (!set) {
      set = new Set()
      this.bySession.set(sessionId, set)
    }
    set.add(approvalId)
    this.emit('registered', this.toPublic(entry))
    return this.toPublic(entry)
  }

  resolve(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): boolean {
    const entry = this.pending.get(approvalId)
    if (!entry || entry.sessionId !== sessionId) return false
    if (entry.timer) clearTimeout(entry.timer)
    entry.resolve(decision)
    this.pending.delete(approvalId)
    this.bySession.get(sessionId)?.delete(approvalId)
    return true
  }

  cancelSession(sessionId: string): void {
    const ids = this.bySession.get(sessionId)
    if (!ids) return
    for (const id of [...ids]) {
      const entry = this.pending.get(id)
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer)
        entry.resolve({ decision: 'cancel' })
        this.pending.delete(id)
      }
    }
    this.bySession.delete(sessionId)
  }

  listPending(sessionId: string): RegisteredApproval[] {
    const ids = this.bySession.get(sessionId)
    if (!ids) return []
    const out: RegisteredApproval[] = []
    for (const id of ids) {
      const entry = this.pending.get(id)
      if (entry) out.push(this.toPublic(entry))
    }
    return out
  }

  size(): number {
    return this.pending.size
  }

  private toPublic(entry: PendingEntry): RegisteredApproval {
    return {
      approvalId: entry.approvalId,
      agentName: entry.agentName,
      sessionId: entry.sessionId,
      toolCallId: entry.toolCallId,
      toolKind: entry.toolKind,
      toolTitle: entry.toolTitle,
      toolInput: entry.toolInput,
      options: entry.options,
      decisionPromise: entry.decisionPromise,
    }
  }
}
