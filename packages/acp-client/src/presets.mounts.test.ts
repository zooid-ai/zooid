import { describe, it, expect } from 'vitest'
import { PRESETS } from './presets.js'

const ctx = {
  agentName: 'alice',
  agentDataDir: '/data/agents/alice',
  containerWorkdir: '/workspace',
  daemonHome: '/home/zooid',
}

describe('preset mount declarations — home / data / config', () => {
  it('claude declares a single `home` mount at ${daemonHome}/.claude', () => {
    const mounts = PRESETS.claude.mounts!(ctx)
    expect(mounts).toHaveLength(1)
    expect(mounts[0]).toMatchObject({
      id: 'home',
      host: '/home/zooid/.claude',
      target: '/root/.claude',
      mode: 'rw',
      create: false,
    })
  })

  it('codex declares a single `home` mount at ${daemonHome}/.codex', () => {
    const mounts = PRESETS.codex.mounts!(ctx)
    expect(mounts).toHaveLength(1)
    expect(mounts[0]).toMatchObject({
      id: 'home',
      host: '/home/zooid/.codex',
      target: '/root/.codex',
      mode: 'rw',
      create: false,
    })
  })

  it('opencode declares `data` + `config` from XDG dirs', () => {
    const mounts = PRESETS.opencode.mounts!(ctx)
    const byId = Object.fromEntries(mounts.map((m) => [m.id, m]))
    expect(Object.keys(byId).sort()).toEqual(['config', 'data'])
    expect(byId.data).toMatchObject({
      host: '/home/zooid/.local/share/opencode',
      target: '/root/.local/share/opencode',
      mode: 'rw',
      create: false,
    })
    expect(byId.config).toMatchObject({
      host: '/home/zooid/.config/opencode',
      target: '/root/.config/opencode',
      mode: 'rw',
      create: false,
    })
  })

  it('preset mounts do not reference `ctx.agentDataDir` (per-agent isolation is opt-in via user mounts)', () => {
    const claudeMounts = PRESETS.claude.mounts!(ctx)
    const codexMounts = PRESETS.codex.mounts!(ctx)
    const opencodeMounts = PRESETS.opencode.mounts!(ctx)
    for (const m of [...claudeMounts, ...codexMounts, ...opencodeMounts]) {
      expect(m.host).not.toContain('/data/agents/alice')
    }
  })

  it('cline / kiro / gemini have no preset-declared mounts', () => {
    expect(PRESETS.cline.mounts?.(ctx) ?? []).toEqual([])
    expect(PRESETS.kiro.mounts?.(ctx) ?? []).toEqual([])
    expect(PRESETS.gemini.mounts?.(ctx) ?? []).toEqual([])
  })
})

describe('pi mount declarations (ZOD073)', () => {
  it('declares a single `home` mount at ${daemonHome}/.pi', () => {
    const mounts = PRESETS.pi.mounts!(ctx)
    expect(mounts).toHaveLength(1)
    expect(mounts[0]).toMatchObject({
      id: 'home',
      host: '/home/zooid/.pi',
      target: '/root/.pi',
      mode: 'rw',
      create: false,
    })
  })

  // The adapter writes ~/.pi/pi-acp/session-map.json on every new session;
  // a read-only mount would lose session/load across container restarts.
  it('mounts rw so pi-acp can persist its session map', () => {
    expect(PRESETS.pi.mounts!(ctx)[0].mode).toBe('rw')
  })

  it('does not reference ctx.agentDataDir', () => {
    for (const m of PRESETS.pi.mounts!(ctx)) {
      expect(m.host).not.toContain('/data/agents/alice')
    }
  })
})

describe('preset default images (unchanged from cycle 1)', () => {
  it('claude, codex, opencode declare a default ghcr image', () => {
    expect(PRESETS.claude.image).toBe('ghcr.io/zooid-ai/agent-claude-code:latest')
    expect(PRESETS.codex.image).toBe('ghcr.io/zooid-ai/agent-codex:latest')
    expect(PRESETS.opencode.image).toBe('ghcr.io/zooid-ai/agent-opencode:latest')
  })

  it('cline / kiro / gemini declare no default image', () => {
    expect(PRESETS.cline.image).toBeUndefined()
    expect(PRESETS.kiro.image).toBeUndefined()
    expect(PRESETS.gemini.image).toBeUndefined()
  })
})
