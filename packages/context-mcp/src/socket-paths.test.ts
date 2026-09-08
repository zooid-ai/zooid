import { describe, expect, it } from 'vitest'
import { agentSocketPath, MAX_RUN_DIR, SUN_PATH_MAX } from './socket-paths.js'

describe('agentSocketPath', () => {
  it('is stable, fixed-width, and safely within sun_path', () => {
    const path = agentSocketPath({ runDir: '/data/run', agentName: 'zooid-assistant' })
    expect(path).toBe(agentSocketPath({ runDir: '/data/run', agentName: 'zooid-assistant' }))
    expect(path).toMatch(/^\/data\/run\/context-[0-9a-f]{12}\.sock$/)
    expect(path.length).toBeLessThanOrEqual(SUN_PATH_MAX)
  })

  it('separates punctuation and case without spending extra path budget', () => {
    const paths = ['Ops/Team #1', 'ops team 1', 'ops-team-1'].map((agentName) =>
      agentSocketPath({ runDir: '/data/run', agentName }),
    )
    expect(new Set(paths).size).toBe(3)
    expect(new Set(paths.map((path) => path.length)).size).toBe(1)
  })

  it('accepts the documented run-dir limit and rejects one byte beyond it', () => {
    const ok = '/' + 'x'.repeat(MAX_RUN_DIR - 1)
    expect(() => agentSocketPath({ runDir: ok, agentName: 'a' })).not.toThrow()
    expect(() => agentSocketPath({ runDir: `${ok}x`, agentName: 'a' })).toThrow(/exceeds the \d+-byte limit/)
  })
})
