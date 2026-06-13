import { describe, expect, it } from 'vitest'
import { AcpClient } from './acp-client.js'
import type { AgentEvent, PresetName } from './index.js'

const E2E = process.env.ZOOID_ACP_E2E === '1'
const PROMPT =
  "let's test your planning tools. Using your tasks/planning tools, make a grocery " +
  'list with bananas, bread, and milk, and then complete it.'

// Per-shim turn budget — real model calls are slow.
const TURN_TIMEOUT_MS = 180_000

interface PlanLike {
  content: string
  status: string
}

// Recognize a planning tool call by its rawInput shape (tool *kind* is an opaque
// ACP enum like "other"/"think", so we key on the payload, not the name).
function planFromToolInput(rawInput: unknown): PlanLike[] | null {
  if (!rawInput || typeof rawInput !== 'object') return null
  const r = rawInput as Record<string, unknown>
  if (Array.isArray(r.todos)) {
    return r.todos
      .map((t) => t as Record<string, unknown>)
      .filter((t) => typeof t.content === 'string' && typeof t.status === 'string')
      .map((t) => ({ content: t.content as string, status: t.status as string }))
  }
  if (Array.isArray(r.plan)) {
    return r.plan
      .map((p) => p as Record<string, unknown>)
      .filter((p) => typeof p.step === 'string' && typeof p.status === 'string')
      .map((p) => ({ content: p.step as string, status: p.status as string }))
  }
  return null
}

interface Classification {
  viaPlanEvent: boolean
  viaToolCall: boolean
  sawInProgressOrCompleted: boolean
  snapshots: number
}

function classify(events: AgentEvent[]): Classification {
  let viaPlanEvent = false
  let viaToolCall = false
  let sawProgress = false
  let snapshots = 0
  for (const ev of events) {
    let entries: PlanLike[] | null = null
    if (ev.type === 'plan') {
      viaPlanEvent = true
      entries = ev.entries.map((e) => ({ content: e.content, status: e.status }))
    } else if (ev.type === 'tool_call' || ev.type === 'tool_call_update') {
      entries = planFromToolInput(ev.rawInput)
      if (entries) viaToolCall = true
    }
    if (entries) {
      snapshots++
      if (entries.some((e) => e.status === 'in_progress' || e.status === 'completed')) {
        sawProgress = true
      }
    }
  }
  return { viaPlanEvent, viaToolCall, sawInProgressOrCompleted: sawProgress, snapshots }
}

async function runShim(preset: PresetName): Promise<Classification> {
  const events: AgentEvent[] = []
  const client = new AcpClient({
    agent: { id: `e2e-${preset}`, preset },
    onEvent: (e) => events.push(e),
    // Auto-approve everything so file/exec tools don't block the turn.
    onApprovalRequest: async (req) => ({
      decision: 'allow',
      optionId: req.options[0]?.optionId ?? 'allow',
    }),
  })
  await client.start()
  try {
    await client.prompt({
      threadId: `e2e-thread-${preset}`,
      content: [{ type: 'text', text: PROMPT }],
    })
  } finally {
    await client.stop()
  }
  return classify(events)
}

describe.skipIf(!E2E)('cross-shim planning tools (opt-in: ZOOID_ACP_E2E=1)', () => {
  for (const preset of ['claude', 'codex', 'opencode'] as const) {
    it(
      `${preset} surfaces a plan in some form, with a status transition`,
      async () => {
        const c = await runShim(preset)
        // Record the finding (visible in test output) — this is the deliverable.
        console.log(`[planning] ${preset}:`, JSON.stringify(c))
        expect(c.viaPlanEvent || c.viaToolCall).toBe(true)
        expect(c.snapshots).toBeGreaterThan(0)
        expect(c.sawInProgressOrCompleted).toBe(true)
      },
      TURN_TIMEOUT_MS,
    )
  }
})
