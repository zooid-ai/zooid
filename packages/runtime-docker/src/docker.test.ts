import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildDockerArgs, mapDockerExitCode } from './docker.js'

describe('buildDockerArgs — base shape', () => {
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
    hostHome: '/Users/alice',
    containerHome: '/root',
  }

  it('builds a docker run invocation with required flags', () => {
    const argv = buildDockerArgs(baseInput)

    expect(argv[0]).toBe('run')
    expect(argv).toContain('--rm')
    expect(argv).toContain('-i')

    const vIndex = argv.indexOf('-v')
    expect(argv[vIndex + 1]).toBe('/Users/alice/projects/myapp:/workspace')

    expect(argv).toContain('-w')
    const wIndex = argv.indexOf('-w')
    expect(argv[wIndex + 1]).toBe('/workspace')

    expect(argv).toContain('ANTHROPIC_API_KEY=sk-...')
    expect(argv).toContain('SESSION_ID=01JQXYZ')
    expect(argv).toContain('MESSAGE_TEXT=fix bug')
    expect(argv.find((a) => a.startsWith('IRRELEVANT='))).toBeUndefined()

    const epIdx = argv.indexOf('--entrypoint')
    expect(epIdx).toBeGreaterThan(-1)
    expect(argv[epIdx + 1]).toBe('claude')

    const imgIdx = argv.indexOf('budd/claude-code:latest')
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
      hostEnv: { ANTHROPIC_API_KEY: 'sk-' },
    })
    expect(argv).toContain('ANTHROPIC_API_KEY=sk-')
    expect(argv.find((a) => a.startsWith('CODEX_API_KEY='))).toBeUndefined()
  })

  it('emits only the workspace -v flag when no mount fields are set', () => {
    const argv = buildDockerArgs({
      ...baseInput,
      args: [],
      workdir: '/tmp',
      envAllowlist: [],
      hostEnv: {},
    })
    const vFlags = argv.reduce(
      (acc, a, i) => (a === '-v' ? [...acc, argv[i + 1]] : acc),
      [] as string[],
    )
    expect(vFlags).toHaveLength(1)
    expect(vFlags[0]).toBe('/tmp:/workspace')
  })
})

describe('buildDockerArgs — workspace RO carveouts', () => {
  let host: string
  beforeEach(() => {
    host = mkdtempSync(join(tmpdir(), 'budd-mount-test-'))
    mkdirSync(join(host, '.claude'), { recursive: true })
    writeFileSync(join(host, 'CLAUDE.md'), '# Instructions\n')
  })
  afterEach(() => rmSync(host, { recursive: true, force: true }))

  it('adds RO binds AFTER the RW workspace bind (later wins)', () => {
    const argv = buildDockerArgs({
      image: 'budd/claude-code:latest',
      command: 'claude',
      args: ['-p', 'hi'],
      workdir: host,
      envAllowlist: [],
      hostEnv: {},
      hostHome: '/tmp/fakehome',
      containerHome: '/root',
      workspaceReadOnly: ['CLAUDE.md', '.claude'],
      homeReadOnly: [],
    })
    const rwIdx = argv.indexOf(`${host}:/workspace`)
    const roFileIdx = argv.indexOf(`${host}/CLAUDE.md:/workspace/CLAUDE.md:ro`)
    const roDirIdx = argv.indexOf(`${host}/.claude:/workspace/.claude:ro`)
    expect(rwIdx).toBeGreaterThan(-1)
    expect(roFileIdx).toBeGreaterThan(rwIdx)
    expect(roDirIdx).toBeGreaterThan(rwIdx)
  })

  it('skips workspaceReadOnly entries that do not exist on host', () => {
    const argv = buildDockerArgs({
      image: 'x',
      command: 'c',
      args: [],
      workdir: host,
      envAllowlist: [],
      hostEnv: {},
      hostHome: '/tmp/fake',
      containerHome: '/root',
      workspaceReadOnly: ['CLAUDE.md', '.claude', 'DOES_NOT_EXIST.md'],
      homeReadOnly: [],
    })
    expect(argv.some((a) => a.includes('DOES_NOT_EXIST'))).toBe(false)
    expect(argv.some((a) => a.includes('CLAUDE.md'))).toBe(true)
  })

  it('honours workspaceReadOnlyDisable (subtractive override)', () => {
    const argv = buildDockerArgs({
      image: 'x',
      command: 'c',
      args: [],
      workdir: host,
      envAllowlist: [],
      hostEnv: {},
      hostHome: '/tmp/fake',
      containerHome: '/root',
      workspaceReadOnly: ['CLAUDE.md', '.claude'],
      workspaceReadOnlyDisable: ['CLAUDE.md'],
      homeReadOnly: [],
    })
    expect(argv.some((a) => a.includes(':/workspace/CLAUDE.md:ro'))).toBe(false)
    expect(argv.some((a) => a.includes(':/workspace/.claude:ro'))).toBe(true)
  })
})

describe('buildDockerArgs — home RO files', () => {
  let hostHome: string
  beforeEach(() => {
    hostHome = mkdtempSync(join(tmpdir(), 'budd-home-test-'))
    mkdirSync(join(hostHome, '.claude'), { recursive: true })
    writeFileSync(join(hostHome, '.claude/settings.json'), '{}\n')
  })
  afterEach(() => rmSync(hostHome, { recursive: true, force: true }))

  it('mounts listed home files RO when they exist', () => {
    const argv = buildDockerArgs({
      image: 'x',
      command: 'c',
      args: [],
      workdir: '/tmp/ws',
      envAllowlist: [],
      hostEnv: {},
      hostHome,
      containerHome: '/root',
      workspaceReadOnly: [],
      homeReadOnly: ['.claude/settings.json', '.claude/not-there.json'],
    })
    expect(argv).toContain(
      `${hostHome}/.claude/settings.json:/root/.claude/settings.json:ro`,
    )
    expect(argv.some((a) => a.includes('not-there'))).toBe(false)
  })
})

describe('buildDockerArgs — sessionStateDir', () => {
  let hostHome: string
  beforeEach(() => {
    hostHome = mkdtempSync(join(tmpdir(), 'budd-sess-test-'))
  })
  afterEach(() => rmSync(hostHome, { recursive: true, force: true }))

  it('adds RW bind for sessionStateDir and pre-creates the host path', () => {
    const argv = buildDockerArgs({
      image: 'x',
      command: 'c',
      args: [],
      workdir: '/tmp/ws',
      envAllowlist: [],
      hostEnv: {},
      hostHome,
      containerHome: '/root',
      workspaceReadOnly: [],
      homeReadOnly: [],
      sessionStateDir: '.claude/projects/-workspace',
    })
    const expected = `${hostHome}/.claude/projects/-workspace:/root/.claude/projects/-workspace:rw`
    expect(argv).toContain(expected)
    expect(existsSync(join(hostHome, '.claude/projects/-workspace'))).toBe(true)
  })
})

describe('buildDockerArgs — extra mounts', () => {
  it('appends user-declared extra mounts with the given mode', () => {
    const argv = buildDockerArgs({
      image: 'x',
      command: 'c',
      args: [],
      workdir: '/tmp/ws',
      envAllowlist: [],
      hostEnv: {},
      hostHome: '/tmp/h',
      containerHome: '/root',
      workspaceReadOnly: [],
      homeReadOnly: [],
      extraMounts: [
        { path: '/abs/docs', target: '/workspace/docs', mode: 'ro' },
        { path: '/abs/cache', target: '/cache', mode: 'rw' },
      ],
    })
    expect(argv).toContain('/abs/docs:/workspace/docs:ro')
    expect(argv).toContain('/abs/cache:/cache:rw')
  })
})

describe('buildDockerArgs — argv ordering contract', () => {
  it('orders: run --rm -i, workspace RW, workspace RO, home RO, sessionState RW, extras, env, entrypoint, image, args', () => {
    const host = mkdtempSync(join(tmpdir(), 'budd-order-'))
    writeFileSync(join(host, 'CLAUDE.md'), 'x')
    const hostHome = mkdtempSync(join(tmpdir(), 'budd-order-home-'))
    mkdirSync(join(hostHome, '.claude'), { recursive: true })
    writeFileSync(join(hostHome, '.claude/settings.json'), '{}')

    const argv = buildDockerArgs({
      image: 'img',
      command: 'cmd',
      args: ['a1', 'a2'],
      workdir: host,
      envAllowlist: ['ANTHROPIC_API_KEY'],
      hostEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      hostHome,
      containerHome: '/root',
      workspaceReadOnly: ['CLAUDE.md'],
      homeReadOnly: ['.claude/settings.json'],
      sessionStateDir: '.claude/projects/-workspace',
      extraMounts: [{ path: '/abs/cache', target: '/cache', mode: 'rw' }],
    })

    expect(argv.slice(0, 3)).toEqual(['run', '--rm', '-i'])
    const wsIdx = argv.indexOf(`${host}:/workspace`)
    const wsRoIdx = argv.indexOf(`${host}/CLAUDE.md:/workspace/CLAUDE.md:ro`)
    const homeRoIdx = argv.indexOf(
      `${hostHome}/.claude/settings.json:/root/.claude/settings.json:ro`,
    )
    const sessionIdx = argv.indexOf(
      `${hostHome}/.claude/projects/-workspace:/root/.claude/projects/-workspace:rw`,
    )
    const extraIdx = argv.indexOf('/abs/cache:/cache:rw')
    const envIdx = argv.indexOf('ANTHROPIC_API_KEY=sk-x')
    const imgIdx = argv.indexOf('img')

    expect(wsIdx).toBeLessThan(wsRoIdx)
    expect(wsRoIdx).toBeLessThan(homeRoIdx)
    expect(homeRoIdx).toBeLessThan(sessionIdx)
    expect(sessionIdx).toBeLessThan(extraIdx)
    expect(extraIdx).toBeLessThan(envIdx)
    expect(envIdx).toBeLessThan(imgIdx)
    expect(argv.slice(imgIdx)).toEqual(['img', 'a1', 'a2'])

    rmSync(host, { recursive: true, force: true })
    rmSync(hostHome, { recursive: true, force: true })
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
