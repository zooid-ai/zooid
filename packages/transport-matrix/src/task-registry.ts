import { randomUUID } from 'node:crypto'
export const MAX_OPEN_TASKS_PER_ROOM = 5
export type TaskPhase = 'reserved' | 'uncertain' | 'open' | 'closed'
export interface TaskRecord {
  taskId: string
  attemptId: string
  roomId: string
  assignee: string
  notify: 'caller' | 'none'
  parent: {
    agent: string
    threadRoot: string
    sessionKey: string
    generation: number
  }
  phase: TaskPhase
  threadRoot?: string
  summary?: string
  runId?: string
  closedAt?: string
}
export interface PersistedTask extends Required<Pick<TaskRecord, 'taskId' | 'attemptId' | 'roomId' | 'assignee' | 'notify' | 'parent' | 'phase'>> {
  threadRoot?: string
  summary?: string
  runId: string
  closedAt?: string
}
export interface TaskJournal { load(): PersistedTask[]; save(tasks: PersistedTask[]): void }
export class TaskRegistry {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly byRoot = new Map<string, string>()
  private readonly generations = new Map<string, number>()
  private readonly runIdValue: string
  constructor(
    private readonly opts: {
      maxOpenPerRoom?: number
      newId?: () => string
      journal?: TaskJournal
      runId?: string
      maxClosedRecords?: number
    } = {},
  ) {
    this.runIdValue = this.opts.runId ?? randomUUID()
  }
  private get max() {
    return this.opts.maxOpenPerRoom ?? MAX_OPEN_TASKS_PER_ROOM
  }
  private get runId() { return this.runIdValue }
  private save() {
    if (!this.opts.journal) return
    const rows = [...this.tasks.values()].map((r) => ({ ...r, runId: r.runId ?? this.runId }) as PersistedTask)
    const max = this.opts.maxClosedRecords ?? 500
    const open = rows.filter((r) => r.phase !== 'closed')
    const closed = rows.filter((r) => r.phase === 'closed').sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '')).slice(0, max)
    this.opts.journal.save([...open, ...closed])
  }
  openCount(roomId: string) {
    return [...this.tasks.values()].filter((t) => t.roomId === roomId && t.phase !== 'closed')
      .length
  }
  reserve(
    input: Omit<TaskRecord, 'taskId' | 'attemptId' | 'phase' | 'threadRoot' | 'summary'>,
  ): TaskRecord | undefined {
    if (this.openCount(input.roomId) >= this.max) return
    const id = this.opts.newId?.() ?? randomUUID()
    const rec: TaskRecord = {
      taskId: id,
      attemptId: id,
      phase: 'reserved',
      runId: this.runId,
      ...input,
    }
    this.tasks.set(id, rec)
    this.save()
    return rec
  }
  activate(taskId: string, threadRoot: string) {
    const r = this.tasks.get(taskId)
    if (!r) return
    r.phase = 'open'
    r.threadRoot = threadRoot
    this.byRoot.set(threadRoot, taskId)
    this.save()
  }
  abandon(taskId: string) {
    this.tasks.delete(taskId)
    this.save()
  }
  markUncertain(taskId: string) {
    const r = this.tasks.get(taskId)
    if (r?.phase === 'reserved') r.phase = 'uncertain'
    this.save()
  }
  adopt(attemptId: string, threadRoot: string) {
    const r = this.tasks.get(attemptId)
    if (!r) return
    if (r.phase === 'closed' || (r.threadRoot && r.threadRoot !== threadRoot)) return r
    this.activate(r.taskId, threadRoot)
    return r
  }
  taskForRoot(threadRoot: string) {
    const id = this.byRoot.get(threadRoot)
    return id ? this.tasks.get(id) : undefined
  }
  openTaskFor(agent: string, root: string) {
    const r = this.taskForRoot(root)
    return r?.phase === 'open' && r.assignee === agent ? r : undefined
  }
  recordSummary(id: string, summary: string) {
    const r = this.tasks.get(id)
    if (!r || r.summary !== undefined) return 'already_recorded' as const
    r.summary = summary
    this.save()
    return 'recorded' as const
  }
  clearSummary(id: string) {
    const r = this.tasks.get(id)
    if (r) r.summary = undefined
    this.save()
  }
  close(id: string) {
    const r = this.tasks.get(id)
    if (!r || r.phase === 'closed') return false
    r.phase = 'closed'
    r.closedAt = new Date().toISOString()
    this.save()
    return true
  }
  /** Reconcile records from a prior daemon run and retain closed roots for trust checks. */
  restore(): TaskRecord[] {
    const rows = this.opts.journal?.load() ?? []
    const interrupted: TaskRecord[] = []
    for (const row of rows) {
      const rec: TaskRecord = { ...row }
      if (rec.phase !== 'closed' && rec.runId !== this.runId) {
        rec.phase = 'closed'; rec.closedAt = new Date().toISOString()
        interrupted.push(rec)
      }
      this.tasks.set(rec.taskId, rec)
      if (rec.threadRoot) this.byRoot.set(rec.threadRoot, rec.taskId)
    }
    this.save()
    return interrupted
  }
  generationOf(agent: string, session: string) {
    return this.generations.get(`${agent}::${session}`) ?? 0
  }
  bumpGeneration(agent: string, session: string) {
    const k = `${agent}::${session}`
    this.generations.set(k, this.generationOf(agent, session) + 1)
  }
}
