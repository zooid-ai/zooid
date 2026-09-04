import { describe, it, expect } from 'vitest'
import {
  parseDockerfileArgs,
  collectPins,
  findOutdated,
  applyPin,
  npmLatestUrl,
  type ImageManifest,
} from './image-versions.js'

const OPENCODE_DOCKERFILE = `FROM ghcr.io/zooid-ai/agent-base:latest

ARG OPENCODE_VERSION=1.18.27
RUN npm install -g opencode-ai@\${OPENCODE_VERSION}
`

const PI_DOCKERFILE = `FROM ghcr.io/zooid-ai/agent-base:latest

ARG PI_VERSION=0.85.0
ARG PI_ACP_VERSION=0.0.33
RUN npm install -g \\
      @earendil-works/pi-coding-agent@\${PI_VERSION} \\
      pi-acp@\${PI_ACP_VERSION}
`

describe('parseDockerfileArgs', () => {
  it('reads ARG NAME=value pairs', () => {
    expect(parseDockerfileArgs(OPENCODE_DOCKERFILE)).toEqual({
      OPENCODE_VERSION: '1.18.27',
    })
  })

  it('reads several ARGs from one file', () => {
    expect(parseDockerfileArgs(PI_DOCKERFILE)).toEqual({
      PI_VERSION: '0.85.0',
      PI_ACP_VERSION: '0.0.33',
    })
  })

  it('tolerates extra whitespace', () => {
    expect(parseDockerfileArgs('ARG   FOO_VERSION=1.2.3   \n')).toEqual({
      FOO_VERSION: '1.2.3',
    })
  })

  it('records a defaultless ARG as an empty string (collectPins rejects it)', () => {
    expect(parseDockerfileArgs('ARG BARE_ARG\n')).toEqual({ BARE_ARG: '' })
  })

  it('ignores ARG-like text inside a comment', () => {
    expect(parseDockerfileArgs('# ARG COMMENTED_VERSION=9.9.9\n')).toEqual({})
  })

  it('returns an empty object for a Dockerfile with no ARGs', () => {
    expect(parseDockerfileArgs('FROM node:22-slim\nRUN echo hi\n')).toEqual({})
  })
})

describe('collectPins', () => {
  const manifest: ImageManifest = {
    'agent-opencode': { OPENCODE_VERSION: 'opencode-ai' },
  }

  it('joins manifest ARG names to Dockerfile ARG defaults', () => {
    expect(collectPins(manifest, { 'agent-opencode': OPENCODE_DOCKERFILE })).toEqual([
      {
        imageDir: 'agent-opencode',
        argName: 'OPENCODE_VERSION',
        packageName: 'opencode-ai',
        version: '1.18.27',
      },
    ])
  })

  it('flattens several images into one list', () => {
    const pins = collectPins(
      {
        'agent-opencode': { OPENCODE_VERSION: 'opencode-ai' },
        'agent-pi': {
          PI_VERSION: '@earendil-works/pi-coding-agent',
          PI_ACP_VERSION: 'pi-acp',
        },
      },
      { 'agent-opencode': OPENCODE_DOCKERFILE, 'agent-pi': PI_DOCKERFILE },
    )
    expect(pins).toHaveLength(3)
    expect(pins.map((p) => p.packageName).sort()).toEqual([
      '@earendil-works/pi-coding-agent',
      'opencode-ai',
      'pi-acp',
    ])
  })

  // Drift, direction 1: the manifest claims an ARG the Dockerfile does not have.
  it('throws when the manifest names an ARG the Dockerfile lacks', () => {
    expect(() =>
      collectPins(
        { 'agent-opencode': { MISSING_VERSION: 'opencode-ai' } },
        { 'agent-opencode': OPENCODE_DOCKERFILE },
      ),
    ).toThrow(/MISSING_VERSION/)
  })

  // Drift, direction 2: a version-bearing ARG nobody claims. This is the one
  // that matters — it catches adding a pin and forgetting versions.json, which
  // would leave the bumper silently ignoring it forever.
  it('throws when a *_VERSION ARG is absent from the manifest', () => {
    expect(() =>
      collectPins({ 'agent-pi': { PI_VERSION: '@earendil-works/pi-coding-agent' } }, {
        'agent-pi': PI_DOCKERFILE,
      }),
    ).toThrow(/PI_ACP_VERSION/)
  })

  it('throws when the manifest names an image with no Dockerfile', () => {
    expect(() => collectPins({ 'agent-ghost': { X_VERSION: 'x' } }, {})).toThrow(
      /agent-ghost/,
    )
  })

  it('throws when a manifest ARG has no default value', () => {
    expect(() =>
      collectPins({ 'agent-x': { BARE_ARG: 'x' } }, { 'agent-x': 'ARG BARE_ARG\n' }),
    ).toThrow(/BARE_ARG/)
  })
})

describe('findOutdated', () => {
  const pins = [
    {
      imageDir: 'agent-opencode',
      argName: 'OPENCODE_VERSION',
      packageName: 'opencode-ai',
      version: '1.15.7',
    },
    {
      imageDir: 'agent-pi',
      argName: 'PI_ACP_VERSION',
      packageName: 'pi-acp',
      version: '0.0.33',
    },
  ]

  it('reports pins whose version differs from latest', () => {
    const out = findOutdated(pins, { 'opencode-ai': '1.18.27', 'pi-acp': '0.0.33' })
    expect(out).toEqual([{ ...pins[0], latest: '1.18.27' }])
  })

  it('reports nothing when every pin matches', () => {
    expect(findOutdated(pins, { 'opencode-ai': '1.15.7', 'pi-acp': '0.0.33' })).toEqual(
      [],
    )
  })

  // Inequality, not semver ordering: the registry's `latest` dist-tag is
  // authoritative, including when upstream yanks and goes backwards.
  it('treats a lower latest as outdated too', () => {
    const out = findOutdated([pins[0]], { 'opencode-ai': '1.15.6' })
    expect(out).toHaveLength(1)
    expect(out[0].latest).toBe('1.15.6')
  })

  it('skips packages with no lookup result rather than guessing', () => {
    expect(findOutdated(pins, {})).toEqual([])
  })
})

describe('applyPin', () => {
  it('rewrites the ARG default in place', () => {
    const next = applyPin(OPENCODE_DOCKERFILE, 'OPENCODE_VERSION', '1.18.27')
    expect(next).toContain('ARG OPENCODE_VERSION=1.18.27')
    expect(next).not.toContain('1.15.7')
  })

  it('leaves the rest of the file byte-identical', () => {
    const next = applyPin(OPENCODE_DOCKERFILE, 'OPENCODE_VERSION', '2.0.0')
    expect(next.split('\n').length).toBe(OPENCODE_DOCKERFILE.split('\n').length)
    expect(next).toContain('RUN npm install -g opencode-ai@${OPENCODE_VERSION}')
  })

  it('rewrites only the named ARG', () => {
    const next = applyPin(PI_DOCKERFILE, 'PI_ACP_VERSION', '0.1.0')
    expect(next).toContain('ARG PI_VERSION=0.85.0')
    expect(next).toContain('ARG PI_ACP_VERSION=0.1.0')
  })

  it('throws when the ARG is not present', () => {
    expect(() => applyPin(OPENCODE_DOCKERFILE, 'NOPE_VERSION', '1.0.0')).toThrow(
      /NOPE_VERSION/,
    )
  })
})

describe('npmLatestUrl', () => {
  it('builds the latest-dist-tag URL for an unscoped package', () => {
    expect(npmLatestUrl('opencode-ai')).toBe(
      'https://registry.npmjs.org/opencode-ai/latest',
    )
  })

  // The slash in a scoped name must be percent-encoded or the registry 404s
  // silently — the single easiest thing to get wrong here.
  it('percent-encodes the slash in a scoped package', () => {
    expect(npmLatestUrl('@zed-industries/codex-acp')).toBe(
      'https://registry.npmjs.org/@zed-industries%2Fcodex-acp/latest',
    )
  })

  it('does not encode the leading @', () => {
    expect(npmLatestUrl('@scope/pkg')).toContain('/@scope%2Fpkg/')
  })
})
