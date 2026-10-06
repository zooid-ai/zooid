export const NOT_YET_IN_INFRA: Record<string, string>
export function isDockerGated(source: string): boolean
export function tierScriptPaths(script: string | undefined): string[]
export interface Census {
  dockerSuites: string[]
  infra: string[]
  socket: string[]
}
export function censusViolations(c: Census & { notYet: Record<string, string> }): string[]
export function readCensus(root: string): Census
