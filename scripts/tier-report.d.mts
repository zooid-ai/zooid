export interface VitestJsonReport {
  numTotalTests: number
  numPendingTests: number
  numTodoTests: number
  testResults: Array<{ name: string; assertionResults: Array<{ fullName?: string; status: string }> }>
}
export function tierViolations(report: VitestJsonReport | undefined): string[]
