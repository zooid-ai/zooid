/** Harness-independent delegated-task contracts ([[ZOD072]]). */
export interface TaskCallerRef {
  agentName: string
  channelId: string
  threadRoot: string
  sessionKey: string
}
export interface StartTaskSpec {
  agent: string
  prompt: string
}
export interface StartTasksInput {
  tasks: StartTaskSpec[]
  notify?: 'caller' | 'none'
}
export type StartTaskResult =
  | { agent: string; status: 'started'; thread_id: string }
  | {
      agent: string
      status: 'refused' | 'failed'
      reason: string
      attempt_id?: string
    }
export interface StartTasksOutput {
  results: StartTaskResult[]
  notify: 'caller' | 'none'
  /** Stated at the point of decision, where the model actually reads it. */
  delivery: string
}
export interface CompleteTaskInput {
  summary: string
}
export interface CompleteTaskOutput {
  status: 'recorded' | 'already_recorded' | 'refused'
  reason?: string
}
/** What this session is, so the surface can gate itself instead of refusing later. */
export interface TaskRole {
  is_task_assignee: boolean
  can_start_task_threads: boolean
}
export interface TaskActions {
  startTasks(caller: TaskCallerRef, input: StartTasksInput): Promise<StartTasksOutput>
  completeTask(caller: TaskCallerRef, input: CompleteTaskInput): Promise<CompleteTaskOutput>
  describeRole(caller: TaskCallerRef): Promise<TaskRole>
}
/** One in-thread handoff inside a delegated task. */
export type InvocationState = 'outstanding' | 'returned' | 'cancelled'
export interface InvocationRecord {
  invocationId: string
  taskId: string
  callerAgent: string
  callerSessionKey: string
  calleeAgent: string
  callEventId?: string
  calleeSessionKey?: string
  state: InvocationState
}
/** Open human-input requests for a session. ZOD078 supplies the implementation. */
export interface PendingInputRegistry {
  countFor(sessionKey: string): number
  cancelFor(sessionKeys: string[]): void
}
export const NO_PENDING_INPUT: PendingInputRegistry = {
  countFor: () => 0,
  cancelFor: () => {},
}
export const THREAD_START_FIELD = 'dev.zooid.thread_start'
export const THREAD_RESULT_FIELD = 'dev.zooid.thread_result'
export interface ThreadStartContent {
  version: 1
  assignee: string
  attempt_id: string
  parent: { agent: string; thread_root: string; session_key: string }
  notify: 'caller' | 'none'
}
export interface ThreadCompletion {
  agent: string
  thread_id: string
  status: 'complete' | 'failed' | 'cancelled' | 'partial'
  output?: { type: 'message'; text: string }
  reason?: string
  error?: string
}
