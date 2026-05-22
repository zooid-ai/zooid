import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DockerAcpRuntime } from './docker-acp.js'

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!dockerAvailable())('DockerAcpRuntime — real bind mount', () => {
  let workDir: string
  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'zooid-mount-smoke-'))
    writeFileSync(join(workDir, 'marker.txt'), 'hello-from-host')
    execSync('docker pull alpine:3', { stdio: 'ignore' })
  }, 60_000)
  afterAll(() => rmSync(workDir, { recursive: true, force: true }))

  it("`docker run` with a bind mount sees the host file's contents", async () => {
    const rt = new DockerAcpRuntime({ defaultImage: 'alpine:3' })
    const child = rt.spawn({
      command: 'cat',
      args: ['/work/marker.txt'],
      cwd: '/',
      mounts: [{ path: workDir, target: '/work', mode: 'ro' }],
    })
    const stdout = await new Promise<string>((resolve, reject) => {
      let buf = ''
      child.stdout!.on('data', (d) => {
        buf += String(d)
      })
      child.on('close', (code) =>
        code === 0 ? resolve(buf) : reject(new Error(`exit ${code}`)),
      )
      child.on('error', reject)
    })
    expect(stdout.trim()).toBe('hello-from-host')
  }, 30_000)
})
