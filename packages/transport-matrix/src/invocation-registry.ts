import { randomUUID } from 'node:crypto'
import type { InvocationRecord } from '@zooid/core'

export class InvocationRegistry {
  private readonly records = new Map<string, InvocationRecord>()
  private readonly byCallee = new Map<string, string>()
  private readonly byEvent = new Map<string, string>()
  constructor(private readonly opts: { newId?: () => string } = {}) {}
  open(input: Omit<InvocationRecord, 'invocationId' | 'state'>): InvocationRecord {
    const record = { invocationId: this.opts.newId?.() ?? randomUUID(), state: 'outstanding' as const, ...input }
    this.records.set(record.invocationId, record)
    return record
  }
  attachCallEvent(id: string, eventId: string, sessionKey: string) {
    const r = this.records.get(id); if (!r) return
    r.callEventId = eventId; r.calleeSessionKey = sessionKey
    this.byEvent.set(eventId, id); this.byCallee.set(sessionKey, id)
  }
  get(id: string) { return this.records.get(id) }
  byCallEvent(eventId: string) { const id = this.byEvent.get(eventId); return id ? this.records.get(id) : undefined }
  forCalleeSession(session: string) { const id = this.byCallee.get(session); return id ? this.records.get(id) : undefined }
  outstandingFor(session: string) { return [...this.records.values()].filter(x => x.state === 'outstanding' && x.callerSessionKey === session) }
  outstandingForTask(taskId: string) { return [...this.records.values()].filter(x => x.state === 'outstanding' && x.taskId === taskId) }
  resolve(id: string) { const r = this.records.get(id); if (!r || r.state !== 'outstanding') return; r.state = 'returned'; return r }
  cancelForTask(taskId: string) { const records = this.outstandingForTask(taskId); for (const r of records) r.state = 'cancelled'; return records }
  ancestorAgents(session: string) {
    const agents: string[] = [], seen = new Set([session]); let cursor = session
    for (;;) { const r = this.forCalleeSession(cursor); if (!r || r.state !== 'outstanding') break; agents.push(r.callerAgent); if (seen.has(r.callerSessionKey)) break; seen.add(r.callerSessionKey); cursor = r.callerSessionKey }
    return agents
  }
  isOutstandingAncestor(session: string, agent: string) { return this.ancestorAgents(session).includes(agent) }
}
