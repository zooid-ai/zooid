import { HANDOFF_FIELD, type HandoffContent } from '@zooid/core'
import { buildMentionContent } from './mention-content.js'

/** A handoff target: a local binding or another workstation's rostered agent. */
export interface HandoffCandidate {
  userId: string
  name: string
  /** Roster state key; undefined for a daemon without a workstation name. */
  workstation?: string
  /** Room ids the agent is bound to. */
  rooms: string[]
}

export type HandoffResolution =
  | { ok: true; target: HandoffCandidate }
  | { ok: false; reason: string }

/** The structured call on an event, or undefined when absent or malformed ([[ZOD092]] §2). */
export function readHandoff(content: unknown): HandoffContent | undefined {
  const h = (content as Record<string, unknown> | undefined)?.[HANDOFF_FIELD] as
    | Partial<HandoffContent>
    | undefined
  if (!h || h.version !== 1) return undefined
  if (typeof h.call_id !== 'string' || typeof h.caller !== 'string' || typeof h.callee !== 'string')
    return undefined
  return { version: 1, call_id: h.call_id, caller: h.caller, callee: h.callee }
}

export function buildHandoffContent(input: {
  callId: string
  caller: string
  callee: string
  prompt: string
}): { msgtype: string; body: string; [k: string]: unknown } {
  return {
    ...buildMentionContent({ userId: input.callee, text: input.prompt, msgtype: 'm.notice' }),
    [HANDOFF_FIELD]: {
      version: 1,
      call_id: input.callId,
      caller: input.caller,
      callee: input.callee,
    } satisfies HandoffContent,
  }
}

const label = (c: HandoffCandidate) => (c.workstation ? `${c.workstation}.${c.name}` : c.name)

/**
 * Resolve the model's `agent` argument: full MXID, `workstation.agent`, or a
 * bare name (a leading `@` is tolerated). The model never has to type an MXID.
 */
export function resolveHandoffTarget(
  agent: string,
  roomId: string,
  candidates: HandoffCandidate[],
): HandoffResolution {
  const q = agent.trim()
  const inRoom = candidates.filter((c) => c.rooms.includes(roomId))
  const roster = inRoom.map(label).sort().join(', ') || 'none'
  let hits: HandoffCandidate[]
  if (q.startsWith('@') && q.includes(':')) hits = candidates.filter((c) => c.userId === q)
  else {
    const bare = q.replace(/^@/, '')
    hits = candidates.filter((c) => label(c) === bare)
    if (hits.length === 0) hits = candidates.filter((c) => c.name === bare)
  }
  if (hits.length === 0)
    return { ok: false, reason: `unknown_agent: no agent "${q}" in this workforce. Agents in this room: ${roster}` }
  if (hits.length > 1)
    return {
      ok: false,
      reason: `ambiguous_agent: "${q}" matches ${hits.map(label).sort().join(', ')} — use workstation.agent`,
    }
  const target = hits[0]!
  if (!target.rooms.includes(roomId))
    return { ok: false, reason: `not_in_room: "${label(target)}" is not in this room. Agents in this room: ${roster}` }
  return { ok: true, target }
}
