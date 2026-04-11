import { describe, it, expect } from 'vitest'
import { buildDockerArgs, mapDockerExitCode } from './docker.js'

describe('buildDockerArgs', () => {
  it('builds a docker run invocation with required flags', () => {
    const argv = buildDockerArgs({
      image: 'zooid/agentd-claude:latest',
      command: 'claude',
      args: ['-p', 'fix bug', '--session-id', '01JQXYZ', '--output-format', 'stream-json'],
      workdir: '/Users/alice/projects/myapp',
      envAllowlist: ['ANTHROPIC_API_KEY', 'SESSION_ID', 'MESSAGE_TEXT'],
      hostEnv: {
        ANTHROPIC_API_KEY: 'sk-...',
        SESSION_ID: '01JQXYZ',
        MESSAGE_TEXT: 'fix bug',
        IRRELEVANT: 'leave me out',
      },
    })

    // Required flags and order
    expect(argv[0]).toBe('run')
    expect(argv).toContain('--rm')
    expect(argv).toContain('-i')

    // Mount
    expect(argv).toContain('-v')
    const vIndex = argv.indexOf('-v')
    expect(argv[vIndex + 1]).toBe('/Users/alice/projects/myapp:/workspace')

    // Workdir inside container
    expect(argv).toContain('-w')
    const wIndex = argv.indexOf('-w')
    expect(argv[wIndex + 1]).toBe('/workspace')

    // Env passthrough — only allowlisted keys
    expect(argv).toContain('-e')
    expect(argv).toContain('ANTHROPIC_API_KEY=sk-...')
    expect(argv).toContain('SESSION_ID=01JQXYZ')
    expect(argv).toContain('MESSAGE_TEXT=fix bug')
    expect(argv.find((a) => a.startsWith('IRRELEVANT='))).toBeUndefined()

    // Image comes after flags
    expect(argv).toContain('zooid/agentd-claude:latest')
    const imgIdx = argv.indexOf('zooid/agentd-claude:latest')

    // Command + args after image
    expect(argv.slice(imgIdx + 1)).toEqual([
      'claude',
      '-p',
      'fix bug',
      '--session-id',
      '01JQXYZ',
      '--output-format',
      'stream-json',
    ])
  })

  it('drops env vars not in the allowlist even if they are set', () => {
    const argv = buildDockerArgs({
      image: 'zooid/agentd-claude:latest',
      command: 'claude',
      args: [],
      workdir: '/tmp',
      envAllowlist: ['ANTHROPIC_API_KEY'],
      hostEnv: { ANTHROPIC_API_KEY: 'sk-', SECRET_FOO: 'nope', HOME: '/root' },
    })
    expect(argv.find((a) => a.startsWith('SECRET_FOO='))).toBeUndefined()
    expect(argv.find((a) => a.startsWith('HOME='))).toBeUndefined()
    expect(argv).toContain('ANTHROPIC_API_KEY=sk-')
  })

  it('omits env entries for allowlisted keys that are undefined', () => {
    const argv = buildDockerArgs({
      image: 'zooid/agentd-claude:latest',
      command: 'claude',
      args: [],
      workdir: '/tmp',
      envAllowlist: ['ANTHROPIC_API_KEY', 'CODEX_API_KEY'],
      hostEnv: { ANTHROPIC_API_KEY: 'sk-' }, // CODEX_API_KEY unset
    })
    expect(argv).toContain('ANTHROPIC_API_KEY=sk-')
    expect(argv.find((a) => a.startsWith('CODEX_API_KEY='))).toBeUndefined()
  })
})

describe('mapDockerExitCode', () => {
  it('passes through agent exit code 0', () => {
    expect(mapDockerExitCode(0)).toEqual({ exit_code: 0 })
  })

  it('passes through agent non-zero exit', () => {
    expect(mapDockerExitCode(2)).toEqual({ exit_code: 2 })
  })

  it('125 (docker daemon failure) becomes a reasoned failure', () => {
    const result = mapDockerExitCode(125)
    expect(result.exit_code).toBe(125)
    expect(result.reason).toMatch(/docker failed to start container/i)
  })

  it('126 (container command not executable) is reasoned', () => {
    const result = mapDockerExitCode(126)
    expect(result.exit_code).toBe(126)
    expect(result.reason).toMatch(/not executable/i)
  })

  it('127 (container command not found) is reasoned', () => {
    const result = mapDockerExitCode(127)
    expect(result.exit_code).toBe(127)
    expect(result.reason).toMatch(/not found/i)
  })
})
