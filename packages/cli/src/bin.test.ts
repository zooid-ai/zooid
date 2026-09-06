import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const TSX = join(HERE, '..', 'node_modules', '.bin', 'tsx')
const BIN = join(HERE, 'bin.ts')

function runCli(args: string[]) {
  const result = spawnSync(TSX, [BIN, ...args], { encoding: 'utf8' })
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

describe('zooid help', () => {
  it('lists every registered command with no args', () => {
    const { stdout, status } = runCli([])
    expect(status).toBe(1)
    for (const name of ['start', 'dev', 'logs', 'status', 'init', 'help']) {
      expect(stdout).toContain(name)
    }
  })

  it('--help prints the same command list and exits 0', () => {
    const { stdout, status } = runCli(['--help'])
    expect(status).toBe(0)
    expect(stdout).toContain('Commands:')
    expect(stdout).toContain('init [dir]')
  })

  it('`zooid help` mirrors `zooid --help`', () => {
    const { stdout, status } = runCli(['help'])
    expect(status).toBe(0)
    expect(stdout).toContain('Commands:')
  })

  it('`zooid help <command>` shows that command\'s own help', () => {
    const { stdout, status } = runCli(['help', 'init'])
    expect(status).toBe(0)
    expect(stdout).toContain('$ zooid init [dir]')
    expect(stdout).toContain('--preset <name>')
  })

  it('`zooid <command> --help` still works directly', () => {
    const { stdout, status } = runCli(['logs', '--help'])
    expect(status).toBe(0)
    expect(stdout).toContain('$ zooid logs [source]')
  })

  it('rejects an unknown subcommand of help', () => {
    const { stdout, stderr, status } = runCli(['help', 'bogus'])
    expect(status).toBe(1)
    expect(stderr).toContain('Unknown command: bogus')
    expect(stdout).toContain('Commands:')
  })

  it('rejects an unknown top-level command instead of exiting silently', () => {
    const { stdout, stderr, status } = runCli(['frobnicate'])
    expect(status).toBe(1)
    expect(stderr).toContain('Unknown command: frobnicate')
    expect(stdout).toContain('Commands:')
  })
})
