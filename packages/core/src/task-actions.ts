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
}
export interface CompleteTaskInput {
  summary: string
}
export interface CompleteTaskOutput {
  status: 'recorded' | 'already_recorded' | 'refused'
  reason?: string
}
export interface TaskActions {
  startTasks(caller: TaskCallerRef, input: StartTasksInput): Promise<StartTasksOutput>
  completeTask(caller: TaskCallerRef, input: CompleteTaskInput): Promise<CompleteTaskOutput>
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
