import type { TapEvent } from '@zooid/core'
import type { LogPaths } from './paths.js'
import { JsonlSink, shouldCaptureUpdate, type Verbosity } from './file-sink.js'

export interface MatrixContext {
  room_id: string
  event_id: string
}

export interface WireAgentCaptureOpts {
  agent: string
  paths: LogPaths
  verbosity: Verbosity
  /** Returns the most-recently-known matrix context for the agent, or null. */
  matrixContext: () => MatrixContext | null
  /** Override for tests. */
  now?: () => Date
}

export interface AgentCapture {
  onTap: (event: TapEvent) => void
  close: () => Promise<void>
}

export function wireAgentCapture(opts: WireAgentCaptureOpts): AgentCapture {
  const sink = new JsonlSink(opts.paths.agentTap(opts.agent))
  const now = opts.now ?? (() => new Date())
  const pending: Promise<unknown>[] = []

  const onTap = (event: TapEvent): void => {
    if (event.kind === 'session_update') {
      const variant =
        (event.update as { sessionUpdate?: string }).sessionUpdate ?? 'unknown'
      if (!shouldCaptureUpdate(opts.verbosity, variant)) return
    }
    const matrix = opts.matrixContext()
    const envelope: Record<string, unknown> = {
      ts: now().toISOString(),
      agent: opts.agent,
      session_id: event.sessionId,
      turn_id: event.turnId,
      kind: event.kind,
    }
    if (matrix) envelope.matrix = matrix
    if (event.kind === 'session_update') envelope.notification = event.update
    else if (event.kind === 'turn_started') envelope.prompt_text = event.promptText
    else if (event.kind === 'turn_completed') envelope.stop_reason = event.stopReason
    pending.push(sink.write(envelope))
  }

  return {
    onTap,
    close: async () => {
      await Promise.all(pending)
      await sink.close()
    },
  }
}
