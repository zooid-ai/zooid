#!/usr/bin/env node
// Usage (from a package): node ../../scripts/test-tier.mjs [--vitest-flag…] <path> [<path>…]
// Runs a package's tier suites by path and fails if any were skipped or
// none were selected. Leading --flags go to vitest. See ZOD098.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTierArgs, tierViolations } from './tier-report.mjs'

const { flags, paths } = parseTierArgs(process.argv.slice(2))
if (paths.length === 0) {
  console.error('test-tier: pass the tier test paths to run')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'zooid-tier-'))
const out = join(dir, 'report.json')
let code = 1
try {
  const run = spawnSync(
    'vitest',
    ['run', '--reporter=default', '--reporter=json', `--outputFile.json=${out}`, ...flags, ...paths],
    { stdio: 'inherit' },
  )
  if (run.error) throw run.error
  const report = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : undefined
  const violations = tierViolations(report)
  for (const v of violations) console.error(`test-tier: ${v}`)
  code = run.status !== 0 ? (run.status ?? 1) : violations.length > 0 ? 1 : 0
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.exit(code)
