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
  pre_turn: "git pull"
  post_turn: "git push"
`)
    expect(config.hooks.pre_turn).toBe('git pull')
    expect(config.hooks.post_turn).toBe('git push')
  })

  it('defaults port to 8080', () => {
    const config = loadConfig(`transport: http\nruntime: local`)
    expect(config.port).toBe(8080)
  })

  it('default runtime flips to docker', () => {
    const config = loadConfig(`transport: http`)
    expect(config.runtime).toBe('docker')
  })

  it('default image is budd/claude-code:latest when runtime is docker', () => {
    const config = loadConfig(`transport: http\nruntime: docker`)
    expect(config.docker?.image).toBe('budd/claude-code:latest')
  })

  it('accepts runtime: docker', () => {
    const config = loadConfig(`transport: http\nruntime: docker`)
    expect(config.runtime).toBe('docker')
    expect(config.docker).toBeDefined()
  })

  it('parses docker.image', () => {
    const config = loadConfig(`
transport: http
runtime: docker
docker:
  image: budd/claude-code:1.2.3
`)
    expect(config.docker?.image).toBe('budd/claude-code:1.2.3')
  })

  it('docker block is undefined when runtime is local', () => {
    const config = loadConfig(`
transport: http
runtime: local
docker:
  image: whatever
`)
    expect(config.docker).toBeUndefined()
  })

  it('parses docker.home_mounts', () => {
    const config = loadConfig(`
transport: http
runtime: docker
docker:
  home_mounts:
    - path: .claude
      mode: rw
    - path: .codex/sessions
      mode: ro
`)
    expect(config.docker?.home_mounts).toEqual([
      { path: '.claude', mode: 'rw' },
      { path: '.codex/sessions', mode: 'ro' },
    ])
  })

  it('rejects invalid home_mounts mode', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: docker
docker:
  home_mounts:
    - path: .claude
      mode: exec
`),
    ).toThrow(/home_mounts\[\]\.mode must be "ro" or "rw"/)
  })

  it('rejects empty home_mounts path', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: docker
docker:
  home_mounts:
    - path: ""
      mode: rw
`),
    ).toThrow(/home_mounts\[\]\.path must be a non-empty string/)
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
    hooks: {} as { pre_turn?: string; post_turn?: string },
  }

  it('CLI port overrides YAML port', () => {
    expect(mergeCliFlags(base, { port: 9090 }).port).toBe(9090)
  })

  it('CLI pre-turn overrides YAML pre-turn', () => {
    const merged = mergeCliFlags(
      { ...base, hooks: { pre_turn: 'echo yaml' } },
      { preTurn: 'echo cli' },
    )
    expect(merged.hooks.pre_turn).toBe('echo cli')
  })

  it('absent CLI flags leave YAML values intact', () => {
    const merged = mergeCliFlags({ ...base, port: 7070 }, {})
    expect(merged.port).toBe(7070)
  })

  it('accepts --runtime docker from CLI flags', () => {
    const merged = mergeCliFlags(base, { runtime: 'docker' })
    expect(merged.runtime).toBe('docker')
    expect(merged.docker?.image).toBe('budd/claude-code:latest')
  })

  it('CLI --image overrides docker.image', () => {
    const dockerBase = {
      ...base,
      runtime: 'docker' as const,
      docker: { image: 'budd/claude-code:1.0.0' },
    }
    const merged = mergeCliFlags(dockerBase, { image: 'custom:2.0' })
    expect(merged.docker?.image).toBe('custom:2.0')
  })

  it('preserves home_mounts from base config through merge', () => {
    const dockerBase = {
      ...base,
      runtime: 'docker' as const,
      docker: {
        image: 'budd/claude-code:latest',
        home_mounts: [{ path: '.claude', mode: 'rw' as const }],
      },
    }
    const merged = mergeCliFlags(dockerBase, {})
    expect(merged.docker?.home_mounts).toEqual([{ path: '.claude', mode: 'rw' }])
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
