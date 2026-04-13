import { describe, it, expect } from 'vitest'
import { buildDockerArgs, mapDockerExitCode } from './docker.js'

describe('buildDockerArgs', () => {
  const baseInput = {
    image: 'budd/claude-code:latest',
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
    homeMounts: [],
    hostHome: '/Users/alice',
    containerHome: '/root',
  }

  it('builds a docker run invocation with required flags', () => {
    const argv = buildDockerArgs(baseInput)

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

    // --entrypoint overrides image ENTRYPOINT so adapter command runs directly
    const epIdx = argv.indexOf('--entrypoint')
    expect(epIdx).toBeGreaterThan(-1)
    expect(argv[epIdx + 1]).toBe('claude')

    // Image comes after --entrypoint <command>
    expect(argv).toContain('budd/claude-code:latest')
    const imgIdx = argv.indexOf('budd/claude-code:latest')

    // Only args (not command) after image — command is in --entrypoint
    expect(argv.slice(imgIdx + 1)).toEqual([
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
      ...baseInput,
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
      ...baseInput,
      args: [],
      workdir: '/tmp',
      envAllowlist: ['ANTHROPIC_API_KEY', 'CODEX_API_KEY'],
      hostEnv: { ANTHROPIC_API_KEY: 'sk-' }, // CODEX_API_KEY unset
    })
    expect(argv).toContain('ANTHROPIC_API_KEY=sk-')
    expect(argv.find((a) => a.startsWith('CODEX_API_KEY='))).toBeUndefined()
  })

  it('generates -v flags for home mounts with correct mode', () => {
    const argv = buildDockerArgs({
      ...baseInput,
      args: [],
      workdir: '/tmp',
      envAllowlist: [],
      hostEnv: {},
      homeMounts: [
        { path: '.claude/settings.json', mode: 'ro' },
        { path: '.claude/projects', mode: 'rw' },
        { path: '.claude/memory', mode: 'rw' },
      ],
      hostHome: '/home/deploy',
      containerHome: '/root',
    })

    expect(argv).toContain('/home/deploy/.claude/settings.json:/root/.claude/settings.json:ro')
    expect(argv).toContain('/home/deploy/.claude/projects:/root/.claude/projects:rw')
    expect(argv).toContain('/home/deploy/.claude/memory:/root/.claude/memory:rw')
  })

  it('places home mounts before env flags', () => {
    const argv = buildDockerArgs({
      ...baseInput,
      args: [],
      workdir: '/tmp',
      envAllowlist: ['ANTHROPIC_API_KEY'],
      hostEnv: { ANTHROPIC_API_KEY: 'sk-' },
      homeMounts: [{ path: '.claude/projects', mode: 'rw' }],
      hostHome: '/home/deploy',
      containerHome: '/root',
    })

    const homeMountIdx = argv.indexOf('/home/deploy/.claude/projects:/root/.claude/projects:rw')
    const envIdx = argv.indexOf('ANTHROPIC_API_KEY=sk-')
    expect(homeMountIdx).toBeLessThan(envIdx)
  })

  it('handles empty homeMounts array', () => {
    const argv = buildDockerArgs({
      ...baseInput,
      args: [],
      workdir: '/tmp',
      envAllowlist: [],
      hostEnv: {},
      homeMounts: [],
    })
    // Only workdir mount, no home mounts
    const vFlags = argv.reduce((acc, a, i) => (a === '-v' ? [...acc, argv[i + 1]] : acc), [] as string[])
    expect(vFlags).toHaveLength(1)
    expect(vFlags[0]).toBe('/tmp:/workspace')
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
