import type { SessionLifecycleEvent } from '@zooid/core'

/**
 * One grep-able line per ACP session lifecycle event, for `zooid start`'s
 * stdout/stderr ([ZOD089]). Carries identities and outcomes only — never
 * prompt or transcript content. Skipped: `unsupported` (the ACP client
 * already warns once per agent) and `cached` recoveries, which fire on every
 * prompt to a live session and would add a line per message.
 */
export function formatLifecycleLine(agentName: string, event: SessionLifecycleEvent): string | null {
  if (event.outcome === 'unsupported') return null
  if (event.recoveryMethod === 'cached') return null
  const what =
    event.outcome === 'recovered'
      ? `recovered (${event.recoveryMethod ?? 'unknown'})`
      : `${event.reason ?? 'close'} → ${event.outcome}`
  return `[lifecycle] ${agentName} key=${event.sessionKey} session=${event.sessionId} ${what}`
}

export function logLifecycle(
  agentName: string,
  event: SessionLifecycleEvent,
  out: Pick<Console, 'log' | 'error'> = console,
): void {
  const line = formatLifecycleLine(agentName, event)
  if (!line) return
  if (event.outcome === 'failed') out.error(line)
  else out.log(line)
}
