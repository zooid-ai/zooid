import type { ThreadState } from './router.js'

/**
 * Separator between a thread root and a handoff-arc call event id inside a
 * session key. Matrix event IDs ('$' + URL-safe base64; legacy '$hash:domain')
 * never contain '|', so composed keys are unambiguous — though nothing below
 * the transport ever parses one: the key is opaque downstream ([[ZOD071]]).
 */
export const HANDOFF_KEY_SEP = '|'

export function composeHandoffKey(threadRoot: string, callEventId: string): string {
  return `${threadRoot}${HANDOFF_KEY_SEP}${callEventId}`
}

/**
 * The session key for an agent's next turn in a thread: its latest handoff
 * arc when it has been called (agent→agent @mention, [[ZOD071]]), else the
 * thread-level key. Relies on the transaction handler recording the arc
 * BEFORE the turn is dispatched, so a just-called sub resolves to the arc
 * minted by its own triggering event.
 */
export function sessionKeyFor(
  agentName: string,
  threadRoot: string,
  state: ThreadState | undefined,
): string {
  const arc = state?.handoffs[agentName]?.at(-1)
  return arc ? composeHandoffKey(threadRoot, arc) : threadRoot
}
