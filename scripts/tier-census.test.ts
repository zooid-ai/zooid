import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  NOT_YET_IN_INFRA,
  censusViolations,
  isDockerGated,
  readCensus,
  tierScriptPaths,
} from './tier-census.mjs'

describe('isDockerGated', () => {
  it('matches the plain guard', () => {
    expect(isDockerGated(`describe.skipIf(!dockerAvailable())('x', () => {})`)).toBe(true)
  })

  it('matches a guard split over lines', () => {
    expect(isDockerGated(`describe.skipIf(!dockerAvailable())(\n  'x',`)).toBe(true)
  })

  it('matches the typing-lease guard that also checks CI', () => {
    expect(isDockerGated(`describe.skipIf(!dockerAvailable() && !process.env.CI)('x', () => {})`)).toBe(true)
  })

  it('ignores a build-output guard', () => {
    expect(isDockerGated(`describe.skipIf(!existsSync(BIN))('x', () => {})`)).toBe(false)
  })
})

describe('tierScriptPaths', () => {
  it('returns [] for a package without the script', () => {
    expect(tierScriptPaths(undefined)).toEqual([])
  })

  it('reads the paths after test-tier.mjs and drops leading flags', () => {
    expect(
      tierScriptPaths('node ../../scripts/test-tier.mjs --no-file-parallelism tests/a.test.ts tests/b.test.ts'),
    ).toEqual(['tests/a.test.ts', 'tests/b.test.ts'])
  })

  it('refuses a tier script that bypasses test-tier.mjs, since its skips would go unchecked', () => {
    expect(() => tierScriptPaths('vitest run tests/')).toThrow(/test-tier\.mjs/)
  })
})

describe('censusViolations', () => {
  const D = 'packages/p/tests/d.integration.test.ts'

  it('accepts a Docker suite in test:infra', () => {
    expect(censusViolations({ dockerSuites: [D], infra: [D], socket: [], notYet: {} })).toEqual([])
  })

  it('accepts a Docker suite on the not-yet list', () => {
    expect(censusViolations({ dockerSuites: [D], infra: [], socket: [], notYet: { [D]: 'zooid-ai/zooid#1' } })).toEqual([])
  })

  it('rejects a Docker suite that runs nowhere', () => {
    const v = censusViolations({ dockerSuites: [D], infra: [], socket: [], notYet: {} })
    expect(v).toHaveLength(1)
    expect(v[0]).toContain(D)
    expect(v[0]).toContain('runs nowhere')
  })

  it('rejects a Docker suite in test:socket even if it is also in test:infra', () => {
    const v = censusViolations({ dockerSuites: [D], infra: [D], socket: [D], notYet: {} })
    expect(v).toEqual([expect.stringContaining('test:socket')])
  })

  it('rejects a suite on both test:infra and the not-yet list, so the list shrinks', () => {
    const v = censusViolations({ dockerSuites: [D], infra: [D], socket: [], notYet: { [D]: 'zooid-ai/zooid#1' } })
    expect(v).toEqual([expect.stringContaining('NOT_YET_IN_INFRA')])
  })

  it('rejects a stale not-yet entry that is no longer a Docker suite', () => {
    const v = censusViolations({ dockerSuites: [], infra: [], socket: [], notYet: { [D]: 'zooid-ai/zooid#1' } })
    expect(v).toEqual([expect.stringContaining('not a Docker suite')])
  })
})

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('the repo census (ZOD098 § 7)', () => {
  const census = readCensus(root)

  it('finds the Docker suites at all, so a broken scan cannot pass empty', () => {
    expect(census.dockerSuites).toContain('packages/cli/tests/typing-lease.integration.test.ts')
    expect(census.dockerSuites).toContain('packages/runtime-docker/src/docker-acp.integration.test.ts')
  })

  it('puts every Docker suite in test:infra or on NOT_YET_IN_INFRA, and none in test:socket', () => {
    expect(censusViolations({ ...census, notYet: NOT_YET_IN_INFRA })).toEqual([])
  })

  it('runs the four self-contained suites in test:infra', () => {
    expect(census.infra).toEqual(
      expect.arrayContaining([
        'packages/cli/tests/typing-lease.integration.test.ts',
        'packages/transport-matrix/tests/context-provider.integration.test.ts',
        'packages/transport-matrix/tests/media.integration.test.ts',
        'packages/runtime-docker/src/docker-acp.integration.test.ts',
      ]),
    )
  })
})
