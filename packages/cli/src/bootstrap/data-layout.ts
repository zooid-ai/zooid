import { join } from 'node:path'

export interface DataLayout {
  dataRoot: string
  matrixDir: string
  logsDir: string
  agentsDir: string
  agentDir: (agentId: string) => string
}

export function resolveDataLayout(dataRoot: string): DataLayout {
  const agentsDir = join(dataRoot, 'agents')
  return {
    dataRoot,
    matrixDir: join(dataRoot, 'matrix'),
    logsDir: join(dataRoot, 'logs'),
    agentsDir,
    agentDir: (id) => join(agentsDir, id),
  }
}
