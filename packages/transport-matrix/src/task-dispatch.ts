import { THREAD_START_FIELD, type ThreadCompletion, type ThreadStartContent } from '@zooid/core'
import { buildMentionContent } from './mention-content.js'
import type { AgentBinding } from './router.js'
export type Admission = { ok: true } | { ok: false; reason: string }
export function checkDelegable(
  agentName: string,
  roomId: string,
  bindings: AgentBinding[],
): Admission {
  const target = bindings.find((b) => b.name === agentName)
  if (!target)
    return {
      ok: false,
      reason: `unknown_agent: no agent named "${agentName}" is configured here`,
    }
  if (!target.rooms.some((r) => r.alias === roomId))
    return {
      ok: false,
      reason: `not_in_room: "${agentName}" is not a member of this room`,
    }
  return { ok: true }
}
export function buildAssignmentContent(input: {
  assigneeUserId: string
  prompt: string
  start: ThreadStartContent
}): { msgtype: string; body: string; [key: string]: unknown } {
  return {
    ...buildMentionContent({
      userId: input.assigneeUserId,
      text: input.prompt,
      msgtype: 'm.notice',
    }),
    [THREAD_START_FIELD]: input.start,
  }
}
export function renderCompletionPrompt(c: ThreadCompletion) {
  return [
    `[task result] ${c.agent} — status: ${c.status} (thread ${c.thread_id})`,
    ...(c.reason ? [`reason: ${c.reason}`] : []),
    ...(c.error ? [`error: ${c.error}`] : []),
    ...(c.output?.text ? ['', c.output.text] : []),
  ].join('\n')
}
export function renderInvocationReturn(c: ThreadCompletion) {
  return [
    `[handoff result] ${c.agent} — status: ${c.status}`,
    ...(c.reason ? [`reason: ${c.reason}`] : []),
    ...(c.error ? [`error: ${c.error}`] : []),
    ...(c.output?.text ? ['', c.output.text] : []),
  ].join('\n')
}
/**
 * The caller's wake for an ordinary-thread handoff return ([[ZOD088]]): the
 * callee's resolving turn, headed so the caller can tell a result from
 * progress ([[ZOD084]]'s wake contract).
 */
export function renderHandoffReturn(r: { callee: string; text: string }): string {
  const text = r.text.trim()
  return text
    ? `[handoff return] from ${r.callee}\n\n${text}`
    : `[handoff return] from ${r.callee} — ended its turn without a reply`
}
export function renderDelivery(notify: 'caller' | 'none'): string {
  return notify === 'caller'
    ? 'Each result returns to you as a new turn when that task completes. End your turn now — do not read the task thread to wait for it.'
    : 'No result returns to you. The task thread is the result surface; thread_id is for later reference, not something to wait on.'
}
/** Stated where the model reads it, like renderDelivery ([[ZOD092]] §1). */
export function renderHandoffDelivery(callee: string): string {
  return `Handed off to ${callee}. End your turn now — do not wait, poll, or post follow-ups. You will be woken with \`[handoff return] from ${callee}\` when it finishes.`
}
export function renderAssigneeEnvelope(input: { parentAgent: string; prompt: string }): string {
  return [
    `[task] from ${input.parentAgent} — you are the assignee of this thread.`,
    'Call zooid_complete_task with a self-contained summary when you are done;',
    'ending your turn without one publishes your last message as the result.',
    'Sibling task threads are refused here — call zooid_handoff to hand off in this thread.',
    '',
    input.prompt,
  ].join('\n')
}
