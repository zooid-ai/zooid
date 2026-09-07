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
}
export class TaskRegistry {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly byRoot = new Map<string, string>()
  private readonly generations = new Map<string, number>()
  constructor(
    private readonly opts: {
      maxOpenPerRoom?: number
      newId?: () => string
    } = {},
  ) {}
  private get max() {
    return this.opts.maxOpenPerRoom ?? MAX_OPEN_TASKS_PER_ROOM
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
      ...input,
    }
    this.tasks.set(id, rec)
    return rec
  }
  activate(taskId: string, threadRoot: string) {
    const r = this.tasks.get(taskId)
    if (!r) return
    r.phase = 'open'
    r.threadRoot = threadRoot
    this.byRoot.set(threadRoot, taskId)
  }
  abandon(taskId: string) {
    this.tasks.delete(taskId)
  }
  markUncertain(taskId: string) {
    const r = this.tasks.get(taskId)
    if (r?.phase === 'reserved') r.phase = 'uncertain'
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
    return 'recorded' as const
  }
  clearSummary(id: string) {
    const r = this.tasks.get(id)
    if (r) r.summary = undefined
  }
  close(id: string) {
    const r = this.tasks.get(id)
    if (!r || r.phase === 'closed') return false
    r.phase = 'closed'
    return true
  }
  generationOf(agent: string, session: string) {
    return this.generations.get(`${agent}::${session}`) ?? 0
  }
  bumpGeneration(agent: string, session: string) {
    const k = `${agent}::${session}`
    this.generations.set(k, this.generationOf(agent, session) + 1)
  }
}
