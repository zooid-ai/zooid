import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PRESETS, VM_PLACEHOLDER_CODEX_KEY } from './presets.js'

const decode = (seg: string) => JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'))

describe('pi vmCredential (ZOD128)', () => {
  const cred = PRESETS.pi.vmCredential!

  it('maps pi to the openai-codex proxy', () => {
    expect(cred).toMatchObject({
      provider: 'openai-codex',
      upstream: 'https://chatgpt.com',
      allowPaths: ['/backend-api/codex/'],
      guestSocket: '/run/zooid/model.sock',
      guestPort: 8787,
      guestEnv: { PI_CODING_AGENT_DIR: '/root/.pi/agent' },
    })
  })

  it('reads its login from a dedicated dir under the daemon home', () => {
    expect(cred.authDir({ daemonHome: '/h' })).toBe('/h/.zooid/cred-proxy/pi')
  })

  it('no other preset has one', () => {
    for (const p of ['claude', 'codex', 'opencode'] as const) expect(PRESETS[p].vmCredential).toBeUndefined()
  })

  it('the placeholder key is an unsigned JWT carrying a fake account claim', () => {
    const [h, p, s] = VM_PLACEHOLDER_CODEX_KEY.split('.')
    expect(decode(h!).alg).toBe('none')
    expect(decode(p!)['https://api.openai.com/auth'].chatgpt_account_id).toBe('zooid-placeholder')
    expect(s).toBe('sig')
  })

  it('the guest setup is credential-free', () => {
    expect(cred.guestSetup).toContain('/root/.pi/agent/models.json')
    expect(cred.guestSetup).toContain('http://127.0.0.1:8787/backend-api')
    expect(cred.guestSetup).toContain(VM_PLACEHOLDER_CODEX_KEY)
    expect(cred.guestSetup).toContain('"transport"')
    expect(cred.guestSetup).not.toContain('auth.json')
  })

  it('the guest setup copies the workdir pi config, points pi at the forwarder, and is idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'zod128-setup-'))
    try {
      mkdirSync(join(root, 'workspace', '.pi-agent', 'sessions'), { recursive: true })
      mkdirSync(join(root, 'workspace', '.pi-agent', 'extensions'), { recursive: true })
      writeFileSync(join(root, 'workspace', '.pi-agent', 'settings.json'), '{"defaultModel":"m"}')
      writeFileSync(join(root, 'workspace', '.pi-agent', 'sessions', 'x'), 'old')
      writeFileSync(join(root, 'workspace', '.pi-agent', 'extensions', 'e.ts'), 'ext')
      const run = () =>
        execFileSync('sh', ['-c', cred.guestSetup], { env: { ...process.env, ZOOID_GUEST_ROOT: root } })
      const agentDir = join(root, 'root', '.pi', 'agent')
      const snapshot = () =>
        Object.fromEntries(
          ['settings.json', 'models.json', 'extensions/e.ts'].map((f) => [f, readFileSync(join(agentDir, f), 'utf8')]),
        )
      run()
      expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))).toEqual({
        defaultModel: 'm',
        transport: 'sse',
      })
      expect(JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8'))).toEqual({
        providers: {
          'openai-codex': { baseUrl: 'http://127.0.0.1:8787/backend-api', apiKey: VM_PLACEHOLDER_CODEX_KEY },
        },
      })
      expect(existsSync(join(agentDir, 'sessions', 'x'))).toBe(false)
      // pi's own sessions in the guest survive a rerun (they back session/load).
      mkdirSync(join(agentDir, 'sessions'), { recursive: true })
      writeFileSync(join(agentDir, 'sessions', 'live'), 'keep')
      expect(readdirSync(agentDir)).not.toContain('auth.json')
      const first = snapshot()
      run()
      expect(snapshot()).toEqual(first)
      expect(readFileSync(join(agentDir, 'sessions', 'live'), 'utf8')).toBe('keep')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the guest setup works with no workdir pi config at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'zod128-setup-'))
    try {
      execFileSync('sh', ['-c', cred.guestSetup], { env: { ...process.env, ZOOID_GUEST_ROOT: root } })
      const agentDir = join(root, 'root', '.pi', 'agent')
      expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))).toEqual({ transport: 'sse' })
      expect(existsSync(join(agentDir, 'models.json'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
