// Decides whether a vitest run satisfied a test tier's contract (ZOD098 § 4):
// it selected at least one test, and none of them skipped.

const NOT_RUN = new Set(['skipped', 'pending', 'todo', 'disabled'])

/** @param {import('./tier-report.d.mts').VitestJsonReport | undefined} report */
export function tierViolations(report) {
  if (!report) return ['vitest wrote no JSON report']
  if (report.numTotalTests === 0) {
    return ['selection matched no tests — a tier step that runs nothing is the bug, not a pass']
  }
  const violations = []
  for (const file of report.testResults) {
    const notRun = file.assertionResults.filter((a) => NOT_RUN.has(a.status)).length
    if (notRun > 0) {
      violations.push(`${file.name}: ${notRun} skipped — a tier-2 suite must run here, check its build-output guard`)
    }
  }
  return violations
}
