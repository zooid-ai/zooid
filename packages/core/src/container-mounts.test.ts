import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadZooidConfig } from './config.js'

const baseTransports = `
transports:
  m1:
    type: matrix
    homeserver: http://localhost:8448
    as_token: t
    hs_token: h
    sender_localpart: z
    user_namespace: '@.*:localhost'
`

const matrixAgent = (extra = ''): string => `
  alice:
    workdir: ./agents/alice
    acp: { preset: claude }
    matrix:
      transport: m1
      user_id: '@alice:localhost'
      rooms: ['!r:localhost']${extra}
`

const wrap = (extra: string): string => `
runtime: docker
${baseTransports}
agents:${matrixAgent(extra)}
`

describe('container.mounts — shape', () => {
  it('parses a minimal mount with default mode rw', () => {
    const cfg = loadZooidConfig(
      wrap(`
    container:
      mounts:
        - host: /var/run/docker.sock
          target: /var/run/docker.sock`),
      { configDir: '/tmp' },
    )
    expect(cfg.agents.alice!.container?.mounts).toEqual([
      { host: '/var/run/docker.sock', target: '/var/run/docker.sock', mode: 'rw' },
    ])
  })

  it('honours explicit mode: ro', () => {
    const cfg = loadZooidConfig(
      wrap(`
    container:
      mounts:
        - host: /etc/hosts
          target: /etc/hosts
          mode: ro`),
      { configDir: '/tmp' },
    )
    expect(cfg.agents.alice!.container?.mounts?.[0]?.mode).toBe('ro')
  })

  it('rejects mode other than ro/rw', () => {
    expect(() =>
      loadZooidConfig(
        wrap(`
    container:
      mounts:
        - host: /a
          target: /a
          mode: rwx`),
        { configDir: '/tmp' },
      ),
    ).toThrow(/mode must be "ro" or "rw"/i)
  })

  it('rejects entries missing host or target', () => {
    expect(() =>
      loadZooidConfig(
        wrap(`
    container:
      mounts:
        - target: /a`),
        { configDir: '/tmp' },
      ),
    ).toThrow(/host.*required/i)
    expect(() =>
      loadZooidConfig(
        wrap(`
    container:
      mounts:
        - host: /a`),
        { configDir: '/tmp' },
      ),
    ).toThrow(/target.*required/i)
  })

  it('rejects duplicate user-declared ids', () => {
    expect(() =>
      loadZooidConfig(
        wrap(`
    container:
      mounts:
        - id: x
          host: /a
          target: /a
        - id: x
          host: /b
          target: /b`),
        { configDir: '/tmp' },
      ),
    ).toThrow(/duplicate.*id.*"x"/i)
  })

  it('rejects the reserved id "workspace" on user entries', () => {
    expect(() =>
      loadZooidConfig(
        wrap(`
    container:
      mounts:
        - id: workspace
          host: /a
          target: /a`),
        { configDir: '/tmp' },
      ),
    ).toThrow(/reserved id.*workspace/i)
  })
})

describe('container.mounts — host path resolution', () => {
  it('keeps absolute paths verbatim', () => {
    const cfg = loadZooidConfig(
      wrap(`
    container:
      mounts:
        - host: /var/lib/foo
          target: /opt/foo`),
      { configDir: '/some/where' },
    )
    expect(cfg.agents.alice!.container?.mounts?.[0]?.host).toBe('/var/lib/foo')
  })

  it('expands ~/... against $HOME', () => {
    const home = process.env.HOME!
    const cfg = loadZooidConfig(
      wrap(`
    container:
      mounts:
        - host: ~/.cache/zooid
          target: /cache`),
      { configDir: '/tmp' },
    )
    expect(cfg.agents.alice!.container?.mounts?.[0]?.host).toBe(`${home}/.cache/zooid`)
  })

  it('resolves relative paths against configDir', () => {
    const cfg = loadZooidConfig(
      wrap(`
    container:
      mounts:
        - host: ./shared
          target: /shared`),
      { configDir: '/example/path' },
    )
    expect(cfg.agents.alice!.container?.mounts?.[0]?.host).toBe('/example/path/shared')
  })

  it('throws on relative host path when configDir is omitted', () => {
    expect(() =>
      loadZooidConfig(
        wrap(`
    container:
      mounts:
        - host: ./shared
          target: /shared`),
        // no configDir
      ),
    ).toThrow(/relative.*host.*configDir/i)
  })
})

describe('container.mounts — ${VAR} interpolation', () => {
  let saved: NodeJS.ProcessEnv
  beforeEach(() => {
    saved = { ...process.env }
  })
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, saved)
  })

  it('expands ${VAR} in host and target', () => {
    process.env.SHARED = '/srv/shared'
    process.env.MOUNTPT = '/mnt/shared'
    const cfg = loadZooidConfig(
      wrap(`
    container:
      mounts:
        - host: \${SHARED}
          target: \${MOUNTPT}`),
      { configDir: '/tmp' },
    )
    expect(cfg.agents.alice!.container?.mounts?.[0]).toMatchObject({
      host: '/srv/shared',
      target: '/mnt/shared',
    })
  })
})

describe('container.disable_mounts', () => {
  it('parses a list of strings', () => {
    const cfg = loadZooidConfig(
      wrap(`
    container:
      disable_mounts: [history, workspace]`),
      { configDir: '/tmp' },
    )
    expect(cfg.agents.alice!.container?.disable_mounts).toEqual(['history', 'workspace'])
  })

  it('rejects empty strings', () => {
    expect(() =>
      loadZooidConfig(
        wrap(`
    container:
      disable_mounts: ['', 'history']`),
        { configDir: '/tmp' },
      ),
    ).toThrow(/disable_mounts.*non-empty string/i)
  })
})

describe('runtime: local + container.mounts', () => {
  it('accepts mounts under runtime: local without error (silently ignored at compose time)', () => {
    const cfg = loadZooidConfig(
      `runtime: local
${baseTransports}
agents:
  alice:
    workdir: ./agents/alice
    acp: { preset: claude }
    matrix:
      transport: m1
      user_id: '@alice:localhost'
      rooms: ['!r:localhost']
    container:
      mounts:
        - host: /a
          target: /a
      disable_mounts: [memory]
`,
      { configDir: '/tmp' },
    )
    expect(cfg.agents.alice!.container?.mounts).toHaveLength(1)
    expect(cfg.agents.alice!.container?.disable_mounts).toEqual(['memory'])
  })
})

describe('post-migration shape — relative workdir + image + env interpolation', () => {
  it('parses an opencode reviewer agent with relative workdir and ${VAR} env', () => {
    const yaml = `
runtime: docker

transports:
  matrix:
    type: matrix
    homeserver: http://localhost:8448
    as_token: \${MATRIX_AS_TOKEN}
    hs_token: \${MATRIX_HS_TOKEN}
    sender_localpart: zooid
    user_namespace: '@.*:localhost'
    port: 9099

agents:
  reviewer:
    workdir: ./agents/reviewer
    acp:
      preset: opencode
    container:
      image: zooid-opencode-vertex:smoke
      env:
        GOOGLE_VERTEX_API_KEY: \${GOOGLE_VERTEX_API_KEY}
    matrix:
      transport: matrix
      user_id: '@reviewer:localhost'
      rooms:
        - '#review:localhost'
      trigger: mention
`
    process.env.MATRIX_AS_TOKEN ??= 'fixture-as'
    process.env.MATRIX_HS_TOKEN ??= 'fixture-hs'
    const cfg = loadZooidConfig(yaml, { configDir: '/example/path' })
    expect(cfg.agents.reviewer!.workdir).toBe('./agents/reviewer')
    expect(cfg.agents.reviewer!.container?.image).toBe('zooid-opencode-vertex:smoke')
  })
})
