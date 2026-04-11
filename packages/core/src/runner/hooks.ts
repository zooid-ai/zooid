import { spawn } from 'node:child_process'

export interface HookResult {
  exit_code: number
  stdout: string
  stderr: string
}

/**
 * Runs a shell command via `sh -c` with the given env and cwd. Captures
 * stdout, stderr, and exit code. Never throws — failures surface in
 * exit_code so callers can decide how to react.
 */
export async function runHook(
  command: string,
  env: Record<string, string>,
  cwd: string,
): Promise<HookResult> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))

    child.on('exit', (code) => {
      resolve({ exit_code: code ?? 1, stdout, stderr })
    })
  })
}
