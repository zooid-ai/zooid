import { describe, expect, it } from 'vitest'
import { resolveDataLayout } from './data-layout.js'

describe('resolveDataLayout', () => {
  it('places matrix, logs, and agents as siblings under the data root', () => {
    const l = resolveDataLayout('/abs/data')
    expect(l.dataRoot).toBe('/abs/data')
    expect(l.matrixDir).toBe('/abs/data/matrix')
    expect(l.logsDir).toBe('/abs/data/logs')
    expect(l.agentsDir).toBe('/abs/data/agents')
  })

  it('agentDir(id) returns `${root}/agents/${id}` — no .zooid/ subdir', () => {
    const l = resolveDataLayout('/abs/data')
    expect(l.agentDir('docs')).toBe('/abs/data/agents/docs')
    expect(l.agentDir('triage-bot')).toBe('/abs/data/agents/triage-bot')
  })

  it('leaves relative roots relative (callers normalize)', () => {
    const l = resolveDataLayout('./data')
    expect(l.matrixDir).toBe('data/matrix')
    expect(l.logsDir).toBe('data/logs')
    expect(l.agentDir('a1')).toBe('data/agents/a1')
  })
})
