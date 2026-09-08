import { describe, it, expect } from 'vitest'
import { loadZooidConfig } from './config.js'

const base = `
runtime: local
transports:
  matrix:
    type: matrix
    homeserver: http://localhost:8448
    as_token: t
    hs_token: h
    user_namespace: '@.*:example.org'
agents:
  product:
    acp: { preset: opencode }
    matrix:
      rooms: ["#product:example.org"]
triggers:
  reconcile:
    webhook:
      provider: github
      event: pull_request
      secret: "topsecret"
    as: "@hook:example.org"
    room: "#product:example.org"
    mention: product
    text: |
      A PR merged.

      \${output}
`

describe('webhook triggers: config', () => {
  it('parses a webhook trigger', () => {
    const t = loadZooidConfig(base).triggers.reconcile
    expect(t.webhook).toEqual({ provider: 'github', event: 'pull_request', secret: 'topsecret' })
    expect(t.schedule).toBeUndefined()
  })

  it('rejects a trigger with both schedule and webhook', () => {
    expect(() =>
      loadZooidConfig(base.replace('    as: "@hook', '    schedule: "0 6 * * 1"\n    as: "@hook')),
    ).toThrow(/triggers\.reconcile: specify either schedule: or webhook:, not both/)
  })

  it('rejects an unknown provider — per-provider verification must exist', () => {
    expect(() => loadZooidConfig(base.replace('provider: github', 'provider: acme'))).toThrow(
      /triggers\.reconcile\.webhook\.provider: unknown provider "acme"/,
    )
  })

  it('requires a secret — fail closed, never "no secret configured so accept"', () => {
    expect(() =>
      loadZooidConfig(base.split('\n').filter((l) => !l.includes('secret:')).join('\n')),
    ).toThrow(/triggers\.reconcile\.webhook\.secret: is required/)
  })

  it('interpolates the secret from the environment', () => {
    process.env.TEST_WH_SECRET = 'from-env'
    try {
      const cfg = loadZooidConfig(base.replace('"topsecret"', '${TEST_WH_SECRET}'))
      expect(cfg.triggers.reconcile.webhook?.secret).toBe('from-env')
    } finally {
      delete process.env.TEST_WH_SECRET
    }
  })
})

/**
 * `custom` is the escape hatch for any signing scheme without a named
 * provider — ed25519, SHA-1 over sorted params, bespoke timestamped base
 * strings. It takes a function rather than declarative fields, because a
 * config language for signing schemes is a mini-DSL that still would not
 * cover them all.
 */
describe('webhook triggers: the custom provider', () => {
  const custom = (block: string) =>
    base.replace(
      `      provider: github
      event: pull_request
      secret: "topsecret"`,
      block,
    )

  it('resolves the verifier path against the zooid.yaml directory', () => {
    const t = loadZooidConfig(
      custom(`      provider: custom
      verify: ./verifiers/shopify.js
      secret: "topsecret"`),
      { configDir: '/srv/workforce' },
    ).triggers.reconcile
    expect(t.webhook).toEqual({
      provider: 'custom',
      verify: '/srv/workforce/verifiers/shopify.js',
      secret: 'topsecret',
    })
  })

  it('leaves an absolute verifier path alone', () => {
    const t = loadZooidConfig(
      custom(`      provider: custom
      verify: /opt/zooid/verify.js
      secret: "topsecret"`),
      { configDir: '/srv/workforce' },
    ).triggers.reconcile
    expect(t.webhook?.verify).toBe('/opt/zooid/verify.js')
  })

  it('requires verify: — there is no built-in scheme to fall back on', () => {
    expect(() =>
      loadZooidConfig(
        custom(`      provider: custom
      secret: "topsecret"`),
        { configDir: '/srv/workforce' },
      ),
    ).toThrow(/triggers\.reconcile\.webhook\.verify: is required when provider: custom/)
  })

  it('rejects a relative verifier path with no configDir to resolve against', () => {
    expect(() =>
      loadZooidConfig(
        custom(`      provider: custom
      verify: ./verify.js
      secret: "topsecret"`),
      ),
    ).toThrow(/triggers\.reconcile\.webhook\.verify: relative path/)
  })

  it('rejects verify: on a named provider, rather than ignoring it', () => {
    expect(() =>
      loadZooidConfig(
        custom(`      provider: github
      verify: ./verify.js
      secret: "topsecret"`),
        { configDir: '/srv/workforce' },
      ),
    ).toThrow(/triggers\.reconcile\.webhook\.verify: only applies to provider: custom/)
  })
})
