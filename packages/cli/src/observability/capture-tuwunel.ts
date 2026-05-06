import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ChildProcess } from 'node:child_process'

/**
 * Tee a child's stdout and stderr to one log file, in arrival order.
 * Returns a promise that resolves once the file has been flushed after
 * the child exits.
 */
export function captureChildToFile(
  child: ChildProcess,
  path: string,
): Promise<void> {
  return (async () => {
    await mkdir(dirname(path), { recursive: true })
    const stream = createWriteStream(path, { flags: 'a' })
    if (child.stdout) child.stdout.on('data', (b: Buffer) => stream.write(b))
    if (child.stderr) child.stderr.on('data', (b: Buffer) => stream.write(b))
    await new Promise<void>((resolve) => {
      child.on('exit', () => stream.end(() => resolve()))
    })
  })()
}
