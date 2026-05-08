import type { ChildProcess } from 'node:child_process'

/**
 * Per-agent ACP block in zooid.yaml. XOR: either a known preset or an
 * explicit command. The schema parser rejects both/neither.
 */
export type AcpAgentSpec =
  | { preset: string; command?: never; args?: never }
  | { preset?: never; command: string; args?: string[] }

/**
 * A single bind mount the runtime should set up for the spawned agent
 * process. Only DockerAcpRuntime honors mounts; LocalAcpRuntime ignores them.
 */
export interface AcpMount {
  /** Host-side source path (absolute). */
  path: string
  /** Container-side target path. */
  target: string
  mode: 'ro' | 'rw'
}

/**
 * What an `AcpRuntime` needs in order to launch the ACP agent process.
 * Unlike the legacy `SpawnConfig`, this is just process-spawn shape — no
 * adapter-specific concepts (no workspaceReadOnly, no sessionStateDir).
 */
export interface AcpSpawnSpec {
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
  /** Container image. Used by DockerAcpRuntime; ignored by LocalAcpRuntime. */
  image?: string
  /** Bind mounts. Used by DockerAcpRuntime; ignored by LocalAcpRuntime. */
  mounts?: AcpMount[]
}

/**
 * A runtime knows how to spawn the ACP shim process (locally, or inside a
 * container). Returns a ChildProcess whose stdio is wired up for ACP NDJSON.
 */
export interface AcpRuntime {
  spawn(spec: AcpSpawnSpec): ChildProcess
}
