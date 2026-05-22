import { describe, it, expect } from 'vitest'
import { PRESETS } from './presets.js'

const ctx = {
  agentName: 'alice',
  agentDataDir: '/data/agents/alice',
  containerWorkdir: '/workspace',
}

describe('preset mount declarations', () => {
  it('claude declares memory and history (no config — file-mount deferred)', () => {
    const mounts = PRESETS.claude.mounts!(ctx)
    const ids = mounts.map((m) => m.id).sort()
    expect(ids).toEqual(['history', 'memory'])
    expect(mounts.find((m) => m.id === 'memory')).toMatchObject({
      host: '/data/agents/alice/.claude/memory',
      target: '/root/.claude/memory',
      mode: 'rw',
      create: true,
    })
    expect(mounts.find((m) => m.id === 'history')).toMatchObject({
      host: '/data/agents/alice/.claude/projects',
      target: '/root/.claude/projects',
      mode: 'rw',
      create: true,
    })
  })

  it('codex declares memory and history', () => {
    const mounts = PRESETS.codex.mounts!(ctx)
    expect(mounts.map((m) => m.id).sort()).toEqual(['history', 'memory'])
  })

  it('opencode declares history and config (no memory store)', () => {
    const mounts = PRESETS.opencode.mounts!(ctx)
    const ids = mounts.map((m) => m.id).sort()
    expect(ids).toEqual(['config', 'history'])
  })

  it('cline / kiro / gemini have no preset-declared mounts', () => {
    expect(PRESETS.cline.mounts?.(ctx) ?? []).toEqual([])
    expect(PRESETS.kiro.mounts?.(ctx) ?? []).toEqual([])
    expect(PRESETS.gemini.mounts?.(ctx) ?? []).toEqual([])
  })
})

describe('preset default images', () => {
  it('claude, codex, opencode declare a default ghcr image', () => {
    expect(PRESETS.claude.image).toBe('ghcr.io/zooid-ai/agent-claude:latest')
    expect(PRESETS.codex.image).toBe('ghcr.io/zooid-ai/agent-codex:latest')
    expect(PRESETS.opencode.image).toBe('ghcr.io/zooid-ai/agent-opencode:latest')
  })

  it('cline / kiro / gemini declare no default image (still unpublished)', () => {
    expect(PRESETS.cline.image).toBeUndefined()
    expect(PRESETS.kiro.image).toBeUndefined()
    expect(PRESETS.gemini.image).toBeUndefined()
  })
})
