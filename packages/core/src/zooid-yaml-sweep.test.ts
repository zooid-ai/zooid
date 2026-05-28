import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadZooidConfig } from './config.js'

const HERE = resolve(fileURLToPath(import.meta.url), '..')

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
    workdir: ./alice
    acp: { preset: claude }
    matrix:
      transport: m1
      user_id: '@alice:localhost'
      rooms: ['!r:localhost']${extra}
`

describe('container: block', () => {
  it('accepts workforce-level container.image as the default', () => {
    const yaml = `
runtime: docker
container:
  image: zooid-agent-base:latest
${baseTransports}
agents:${matrixAgent()}
`
    const cfg = loadZooidConfig(yaml)
    expect(cfg.container?.image).toBe('zooid-agent-base:latest')
  })

  it('accepts per-agent container.image overriding the workforce default', () => {
    const yaml = `
runtime: docker
container:
  image: base:1
${baseTransports}
agents:${matrixAgent(`
    container:
      image: alice:2`)}
`
    const cfg = loadZooidConfig(yaml)
    expect(cfg.agents.alice!.container?.image).toBe('alice:2')
  })

  it('rejects container at workforce level when runtime: local', () => {
    const yaml = `
runtime: local
container: { image: x:1 }
${baseTransports}
agents:${matrixAgent()}
`
    expect(() => loadZooidConfig(yaml)).toThrow(
      /container.*only valid when runtime is 'docker' or 'podman'/i,
    )
  })

  it('rejects per-agent container under runtime: local', () => {
    const yaml = `
runtime: local
${baseTransports}
agents:${matrixAgent(`
    container:
      image: x:1`)}
`
    expect(() => loadZooidConfig(yaml)).toThrow(
      /alice\.container.*only valid when runtime is 'docker' or 'podman'/i,
    )
  })
})

describe('container.env interpolation', () => {
  let saved: NodeJS.ProcessEnv
  beforeEach(() => {
    saved = { ...process.env }
  })
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, saved)
  })

  it('passes literal values through unchanged', () => {
    const yaml = `
runtime: docker
${baseTransports}
agents:${matrixAgent(`
    container:
      env:
        LOG_LEVEL: info`)}
`
    const cfg = loadZooidConfig(yaml)
    expect(cfg.agents.alice!.container?.env).toEqual({ LOG_LEVEL: 'info' })
  })

  it('expands ${VAR} from process.env', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    const yaml = `
runtime: docker
${baseTransports}
agents:${matrixAgent(`
    container:
      env:
        ANTHROPIC_API_KEY: \${ANTHROPIC_API_KEY}`)}
`
    const cfg = loadZooidConfig(yaml)
    expect(cfg.agents.alice!.container?.env?.ANTHROPIC_API_KEY).toBe('sk-test')
  })

  it('honours ${VAR:-default} when the var is unset', () => {
    delete process.env.MODEL
    const yaml = `
runtime: docker
${baseTransports}
agents:${matrixAgent(`
    container:
      env:
        MODEL: \${MODEL:-claude-opus-4-7}`)}
`
    const cfg = loadZooidConfig(yaml)
    expect(cfg.agents.alice!.container?.env?.MODEL).toBe('claude-opus-4-7')
  })

  it('resolves missing references to empty string (compose parity)', () => {
    delete process.env.ABSENT
    const yaml = `
runtime: docker
${baseTransports}
agents:${matrixAgent(`
    container:
      env:
        K: \${ABSENT}`)}
`
    const cfg = loadZooidConfig(yaml)
    expect(cfg.agents.alice!.container?.env?.K).toBe('')
  })

  it('rejects ${ZOOID_TOKEN} reference', () => {
    process.env.ZOOID_TOKEN = 'leak'
    const yaml = `
runtime: docker
${baseTransports}
agents:${matrixAgent(`
    container:
      env:
        TOKEN: \${ZOOID_TOKEN}`)}
`
    expect(() => loadZooidConfig(yaml)).toThrow(/ZOOID_/i)
  })

  it('rejects ${ZOOID_X} reference inside a composed value', () => {
    process.env.ZOOID_INTERNAL = 'leak'
    const yaml = `
runtime: docker
${baseTransports}
agents:${matrixAgent(`
    container:
      env:
        K: 'prefix-\${ZOOID_INTERNAL}'`)}
`
    expect(() => loadZooidConfig(yaml)).toThrow(/ZOOID_/i)
  })

  it('rejects a key in the ZOOID_* namespace', () => {
    const yaml = `
runtime: docker
${baseTransports}
agents:${matrixAgent(`
    container:
      env:
        ZOOID_FOO: literal`)}
`
    expect(() => loadZooidConfig(yaml)).toThrow(/ZOOID_/i)
  })

  it('rejects non-string env values (numbers, booleans)', () => {
    const yaml = `
runtime: docker
${baseTransports}
agents:${matrixAgent(`
    container:
      env:
        PORT: 8080`)}
`
    expect(() => loadZooidConfig(yaml)).toThrow(/string/i)
  })
})

describe('agent transport-kind block', () => {
  it('parses matrix block with all fields', () => {
    const yaml = `
runtime: docker
${baseTransports}
agents:
  alice:
    workdir: ./alice
    acp: { preset: claude }
    matrix:
      transport: m1
      user_id: '@alice:localhost'
      rooms: ['!r:localhost']
      trigger: any
`
    const cfg = loadZooidConfig(yaml)
    expect(cfg.agents.alice!.matrix).toEqual({
      transport: 'm1',
      user_id: '@alice:localhost',
      rooms: [{ alias: '!r:localhost' }],
      trigger: 'any',
    })
    expect(cfg.agents.alice!.http).toBeUndefined()
  })

  it('defaults trigger to "mention" when omitted', () => {
    const yaml = `
runtime: docker
${baseTransports}
agents:${matrixAgent()}
`
    const cfg = loadZooidConfig(yaml)
    expect(cfg.agents.alice!.matrix?.trigger).toBe('mention')
  })

  it('rejects an agent with zero transport-kind blocks', () => {
    const yaml = `
runtime: docker
${baseTransports}
agents:
  alice:
    workdir: ./alice
    acp: { preset: claude }
`
    expect(() => loadZooidConfig(yaml)).toThrow(/exactly one transport.*block/i)
  })

  it('rejects an agent with two transport-kind blocks', () => {
    const yaml = `
runtime: docker
transports:
  m1: { type: matrix, homeserver: x, as_token: t, hs_token: h, sender_localpart: z, user_namespace: '@.*:l' }
  h1: { type: http, port: 8080 }
agents:
  alice:
    workdir: ./alice
    acp: { preset: claude }
    matrix:
      transport: m1
      user_id: '@alice:localhost'
      rooms: ['!r:localhost']
    http:
      transport: h1
`
    expect(() => loadZooidConfig(yaml)).toThrow(/exactly one transport.*block/i)
  })

  it('rejects matrix block whose transport ref points at an http transport', () => {
    const yaml = `
runtime: docker
transports:
  h1: { type: http, port: 8080 }
agents:
  alice:
    workdir: ./alice
    acp: { preset: claude }
    matrix:
      transport: h1
      user_id: '@alice:localhost'
      rooms: ['!r:localhost']
`
    expect(() => loadZooidConfig(yaml)).toThrow(
      /matrix.*references transport.*type: http/i,
    )
  })

  it('rejects matrix block whose transport ref does not exist', () => {
    const yaml = `
runtime: docker
${baseTransports}
agents:
  alice:
    workdir: ./alice
    acp: { preset: claude }
    matrix:
      transport: nope
      user_id: '@alice:localhost'
      rooms: ['!r:localhost']
`
    expect(() => loadZooidConfig(yaml)).toThrow(/transport "nope" is not declared/i)
  })

  it('parses http block', () => {
    const yaml = `
runtime: docker
transports:
  h1: { type: http, port: 8080 }
agents:
  alice:
    workdir: ./alice
    acp: { preset: claude }
    http:
      transport: h1
`
    const cfg = loadZooidConfig(yaml)
    expect(cfg.agents.alice!.http).toEqual({ transport: 'h1' })
    expect(cfg.agents.alice!.matrix).toBeUndefined()
  })
})

describe('legacy field migration', () => {
  it('rejects top-level docker: block with a pointer to ZOD043', () => {
    const yaml = `
runtime: docker
docker:
  image: x:1
${baseTransports}
agents:${matrixAgent()}
`
    expect(() => loadZooidConfig(yaml)).toThrow(/Top-level 'docker'.*ZOD043/i)
  })

  it('rejects per-agent docker: block', () => {
    const yaml = `
runtime: docker
${baseTransports}
agents:${matrixAgent(`
    docker:
      image: x:1`)}
`
    expect(() => loadZooidConfig(yaml)).toThrow(/agents\.alice\.docker.*ZOD043/i)
  })

  it('rejects flat agent transport: string', () => {
    const yaml = `
runtime: docker
${baseTransports}
agents:
  alice:
    workdir: ./alice
    acp: { preset: claude }
    transport: m1
    matrix:
      transport: m1
      user_id: '@alice:localhost'
      rooms: ['!r:localhost']
`
    expect(() => loadZooidConfig(yaml)).toThrow(/transport[\s\S]*ZOD043/i)
  })

  it('rejects flat matrix_user_id / rooms / trigger fields', () => {
    const yaml = `
runtime: docker
${baseTransports}
agents:
  alice:
    workdir: ./alice
    acp: { preset: claude }
    matrix_user_id: '@alice:localhost'
    rooms: ['!r:localhost']
`
    expect(() => loadZooidConfig(yaml)).toThrow(/matrix_user_id.*ZOD043/i)
  })
})

describe('example fixtures parse cleanly', () => {
  for (const rel of [
    './__fixtures__/zooid-dev.yaml',
    './__fixtures__/triage-agent.yaml',
    './__fixtures__/opencode-vertex-gemini.yaml',
    './__fixtures__/ec2-workspace.yaml',
  ]) {
    it(`parses ${rel}`, () => {
      const path = resolve(HERE, rel)
      const text = readFileSync(path, 'utf8')
      process.env.MATRIX_AS_TOKEN ??= 'fixture-as'
      process.env.MATRIX_HS_TOKEN ??= 'fixture-hs'
      expect(() => loadZooidConfig(text)).not.toThrow()
    })
  }
})
