import { describe, expect, it } from 'vitest'
import { parseTierArgs, tierViolations, type VitestJsonReport } from './tier-report.mjs'

const file = (name: string, statuses: string[]) => ({
  name,
  assertionResults: statuses.map((status, i) => ({ fullName: `${name} #${i}`, status })),
})

const report = (files: ReturnType<typeof file>[]): VitestJsonReport => {
  const all = files.flatMap((f) => f.assertionResults)
  return {
    numTotalTests: all.length,
    numPendingTests: all.filter((a) => a.status === 'skipped' || a.status === 'pending').length,
    numTodoTests: all.filter((a) => a.status === 'todo').length,
    testResults: files,
  }
}

describe('tierViolations', () => {
  it('accepts a run where every selected test ran', () => {
    expect(tierViolations(report([file('/p/src/integration.test.ts', ['passed', 'failed'])]))).toEqual([])
  })

  it('rejects an empty selection — a green step that ran zero tests', () => {
    expect(tierViolations(report([]))).toEqual([
      'selection matched no tests — a tier step that runs nothing is the bug, not a pass',
    ])
  })

  it('rejects a suite skipped by its build-output guard, naming the file', () => {
    const v = tierViolations(report([file('/p/src/integration.test.ts', ['skipped', 'skipped', 'passed'])]))
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('/p/src/integration.test.ts')
    expect(v[0]).toContain('2 skipped')
  })

  it('treats pending and todo as skipped too', () => {
    const v = tierViolations(report([file('/p/a.test.ts', ['pending']), file('/p/b.test.ts', ['todo'])]))
    expect(v).toHaveLength(2)
  })

  it('rejects a missing report rather than trusting the exit code', () => {
    expect(tierViolations(undefined)).toEqual(['vitest wrote no JSON report'])
  })
})

describe('parseTierArgs', () => {
  it('treats everything as paths when there are no flags', () => {
    expect(parseTierArgs(['src/a.test.ts', 'tests/'])).toEqual({ flags: [], paths: ['src/a.test.ts', 'tests/'] })
  })

  it('passes leading --flags through and keeps the rest as paths', () => {
    expect(parseTierArgs(['--no-file-parallelism', '--testTimeout=60000', 'tests/x.test.ts'])).toEqual({
      flags: ['--no-file-parallelism', '--testTimeout=60000'],
      paths: ['tests/x.test.ts'],
    })
  })

  it('only leading flags count, so a later --flag is a path for vitest to reject', () => {
    expect(parseTierArgs(['a.test.ts', '--bail=1']).paths).toEqual(['a.test.ts', '--bail=1'])
  })

  it('returns no paths for flags alone, which the runner rejects', () => {
    expect(parseTierArgs(['--no-file-parallelism'])).toEqual({ flags: ['--no-file-parallelism'], paths: [] })
  })
})
