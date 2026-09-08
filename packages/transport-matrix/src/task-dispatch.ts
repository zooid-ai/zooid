import { THREAD_START_FIELD, type ThreadCompletion, type ThreadStartContent } from '@zooid/core'
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
  const escaped = input.prompt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = `${input.assigneeUserId} ${input.prompt}`.trim()
  return {
    msgtype: 'm.notice',
    body,
    format: 'org.matrix.custom.html',
    formatted_body: `<a href="https://matrix.to/#/${encodeURIComponent(input.assigneeUserId)}">${input.assigneeUserId}</a> ${escaped}`,
    'm.mentions': { user_ids: [input.assigneeUserId] },
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
