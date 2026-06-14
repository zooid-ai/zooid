import { describe, expect, it } from 'vitest'
import { AcpClient } from './acp-client.js'
import type { PresetName } from './index.js'
import type { TapEvent } from './turn-tracker.js'

const E2E = process.env.ZOOID_ACP_E2E === '1'
const TURN_TIMEOUT_MS = 120_000

interface Advert {
  advertised: boolean
  updateCount: number
  totalCommands: number
  sampleNames: string[]
  firstSeenBeforeTurnEnd: boolean
}

async function probe(preset: PresetName): Promise<Advert> {
  const taps: TapEvent[] = []
  const client = new AcpClient({
    agent: { id: `e2e-${preset}`, preset },
    onEvent: () => {},
    onApprovalRequest: async (req) => ({
      decision: 'allow',
      optionId: req.options[0]?.optionId ?? 'allow',
    }),
    onTap: (e) => taps.push(e),
  })
  await client.start()
  try {
    await client.prompt({ threadId: `e2e-cmd-${preset}`, content: [{ type: 'text', text: 'hi' }] })
  } finally {
    await client.stop()
  }

  const updates = taps.filter(
    (t): t is Extract<TapEvent, { kind: 'session_update' }> =>
      t.kind === 'session_update' && t.update.sessionUpdate === 'available_commands_update',
  )
  const names = new Set<string>()
  for (const u of updates) {
    for (const c of (u.update as { availableCommands?: Array<{ name?: string }> }).availableCommands ?? []) {
      if (typeof c.name === 'string') names.add(c.name)
    }
  }
  return {
    advertised: updates.length > 0,
    updateCount: updates.length,
    totalCommands: names.size,
    sampleNames: [...names].slice(0, 8),
    firstSeenBeforeTurnEnd: updates.length > 0,
  }
}

describe.skipIf(!E2E)('cross-shim command advertisement (opt-in: ZOOID_ACP_E2E=1)', () => {
  for (const preset of ['claude', 'codex', 'opencode'] as const) {
    it(
      `${preset}: record whether commands are advertised over ACP`,
      async () => {
        const a = await probe(preset)
        console.log(`[commands] ${preset}:`, JSON.stringify(a))
        if (a.advertised) expect(a.sampleNames.every((n) => n.length > 0)).toBe(true)
      },
      TURN_TIMEOUT_MS,
    )
  }
})
