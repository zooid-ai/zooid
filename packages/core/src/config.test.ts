import { describe, it, expect } from 'vitest'
import { loadConfig, mergeCliFlags } from './config.js'

describe('loadConfig', () => {
  it('parses a minimal daemon.yaml', () => {
    const config = loadConfig(`
transport: http
port: 8080
runtime: local
`)
    expect(config).toEqual({
      transport: 'http',
      port: 8080,
      runtime: 'local',
      hooks: {},
    })
  })

  it('parses hooks', () => {
    const config = loadConfig(`
transport: http
hooks:
  pre_start: "git pull"
  post_end: "git push"
`)
    expect(config.hooks.pre_start).toBe('git pull')
    expect(config.hooks.post_end).toBe('git push')
  })

  it('defaults port to 8080', () => {
    const config = loadConfig(`transport: http\nruntime: local`)
    expect(config.port).toBe(8080)
  })

  it('default runtime flips to docker', () => {
    const config = loadConfig(`transport: http`)
    expect(config.runtime).toBe('docker')
  })

  it('default image is zooid/agentd-claude:latest when runtime is docker', () => {
    const config = loadConfig(`transport: http\nruntime: docker`)
    expect(config.image).toBe('zooid/agentd-claude:latest')
  })

  it('accepts runtime: docker', () => {
    const config = loadConfig(`transport: http\nruntime: docker`)
    expect(config.runtime).toBe('docker')
  })

  it('parses image field when runtime is docker', () => {
    const config = loadConfig(`
transport: http
runtime: docker
image: zooid/agentd-claude:1.2.3
`)
    expect(config.image).toBe('zooid/agentd-claude:1.2.3')
  })

  it('image field is ignored when runtime is local', () => {
    const config = loadConfig(`
transport: http
runtime: local
image: whatever
`)
    expect(config.image).toBeUndefined()
  })

  it('rejects unknown transport', () => {
    expect(() => loadConfig(`transport: slack`)).toThrow(
      /transport must be "http"/,
    )
  })

  it('rejects non-integer port', () => {
    expect(() => loadConfig(`transport: http\nport: "eighty"`)).toThrow(
      /port must be an integer/,
    )
  })

  it('rejects malformed yaml', () => {
    expect(() => loadConfig(`transport: http\n  bad: indent`)).toThrow()
  })
})

describe('mergeCliFlags', () => {
  const base = {
    transport: 'http' as const,
    port: 8080,
    runtime: 'local' as const,
    hooks: {} as { pre_start?: string; post_end?: string },
  }

  it('CLI port overrides YAML port', () => {
    expect(mergeCliFlags(base, { port: 9090 }).port).toBe(9090)
  })

  it('CLI pre-start overrides YAML pre-start', () => {
    const merged = mergeCliFlags(
      { ...base, hooks: { pre_start: 'echo yaml' } },
      { preStart: 'echo cli' },
    )
    expect(merged.hooks.pre_start).toBe('echo cli')
  })

  it('absent CLI flags leave YAML values intact', () => {
    const merged = mergeCliFlags({ ...base, port: 7070 }, {})
    expect(merged.port).toBe(7070)
  })

  it('accepts --runtime docker from CLI flags', () => {
    expect(mergeCliFlags(base, { runtime: 'docker' }).runtime).toBe('docker')
  })

  it('rejects unknown --runtime values from CLI flags', () => {
    expect(() => mergeCliFlags(base, { runtime: 'firecracker' })).toThrow(
      /runtime must be "local" or "docker"/,
    )
  })

  it('rejects --transport slack from CLI flags', () => {
    expect(() => mergeCliFlags(base, { transport: 'slack' })).toThrow(
      /transport must be "http"/,
    )
  })
})
