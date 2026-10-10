import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { VM_PLACEHOLDER_CODEX_KEY } from '@zooid/acp-client'
import type { AgentConfig, ZooidConfig } from '@zooid/core'
import { SMOLVM_BIN, defaultVmExec, vmMachineName } from '@zooid/runtime-vm'
import { startCredentialProxy } from '../src/cred-proxy/proxy.js'
import { provisionVms, type VmsHandle } from '../src/provision-vms.js'

function smolvmAvailable(): boolean {
  try {
    execSync('smolvm --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
// A test JWT: unsigned, fake account. Never a real credential.
const TEST_JWT = `${b64({ alg: 'none' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' } })}.x`

describe.skipIf(!smolvmAvailable())('credential proxy into a real vm guest (ZOD128)', () => {
  let root: string
  let configDir: string
  let fake: Server
  let fakeUrl: string
  let handle: VmsHandle | undefined
  let machine: string
  const seen: Array<{ url?: string; headers: IncomingHttpHeaders }> = []

  const guest = (cmd: string[]) =>
    defaultVmExec(SMOLVM_BIN, ['machine', 'exec', '--timeout', '30s', '--name', machine, '--', ...cmd])

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'zod128-cp-'))
    configDir = join(root, 'wf')
    mkdirSync(join(configDir, 'agents', 'smoke', '.pi-agent'), { recursive: true })
    writeFileSync(join(configDir, 'agents', 'smoke', '.pi-agent', 'settings.json'), '{"defaultModel":"m"}')
    const home = join(root, 'home')
    mkdirSync(join(home, '.zooid', 'cred-proxy', 'pi'), { recursive: true })
    writeFileSync(
      join(home, '.zooid', 'cred-proxy', 'pi', 'auth.json'),
      JSON.stringify({
        'openai-codex': { type: 'oauth', access: TEST_JWT, refresh: 'R', expires: Date.now() + 3_600_000 },
      }),
      { mode: 0o600 },
    )
    fake = createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers })
      req.resume()
      req.on('end', () => res.writeHead(207).end('fake'))
    })
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()))
    fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
    const smoke: AgentConfig = {
      name: 'smoke',
      workdir: './agents/smoke',
      hooks: {},
      acp: { preset: 'pi' } as AgentConfig['acp'],
      approval_timeout_ms: 0,
      session_idle_timeout_ms: 0,
      runtime: 'vm',
      vm: { image: 'node:22-alpine', cpus: 1, memory_mib: 1024 },
    }
    const cfg = { runtime: 'local', transports: {}, agents: { smoke }, hooks: {} } as unknown as ZooidConfig
    machine = vmMachineName('smoke', configDir)
    handle = await provisionVms({
      cfg,
      configDir,
      agentsDir: join(root, 'data', 'agents'),
      daemonHome: home,
      // Same proxy, pointed at the fake instead of chatgpt.com.
      startProxy: (o) => startCredentialProxy({ ...o, upstream: fakeUrl }),
      log: () => {},
    })
  }, 300_000)

  afterAll(async () => {
    await handle?.stop()
    await defaultVmExec(SMOLVM_BIN, ['machine', 'delete', '--name', machine, '--force']).catch(() => {})
    await new Promise((r) => fake?.close(r))
    rmSync(root, { recursive: true, force: true })
  }, 120_000)

  async function guestFetch(path: string, method: string): Promise<string> {
    const script =
      `fetch('http://127.0.0.1:8787${path}',{method:'${method}',headers:{authorization:'Bearer ${VM_PLACEHOLDER_CODEX_KEY}','chatgpt-account-id':'zooid-placeholder'}})` +
      `.then(r=>console.log(r.status),e=>console.log('ERR',e.message))`
    // The forwarder is detached; give it a moment on first use.
    for (let i = 0; i < 20; i++) {
      const out = (await guest(['node', '-e', script])).stdout.trim()
      if (!out.startsWith('ERR')) return out
      await new Promise((r) => setTimeout(r, 250))
    }
    return 'ERR'
  }

  it('a guest call reaches upstream carrying the host credential', async () => {
    expect(await guestFetch('/backend-api/codex/responses', 'POST')).toBe('207')
    const last = seen.at(-1)!
    expect(last.url).toBe('/backend-api/codex/responses')
    expect(last.headers.authorization).toBe(`Bearer ${TEST_JWT}`)
    expect(last.headers['chatgpt-account-id']).toBe('acct-test')
  }, 120_000)

  it('the guest holds only the placeholder', async () => {
    const models = await guest(['cat', '/root/.pi/agent/models.json'])
    expect(models.stdout).toContain(VM_PLACEHOLDER_CODEX_KEY)
    expect(models.stdout).not.toContain(TEST_JWT)
    const ls = await guest(['ls', '/root/.pi/agent'])
    expect(ls.stdout.split(/\s+/)).not.toContain('auth.json')
    const settings = await guest(['cat', '/root/.pi/agent/settings.json'])
    expect(JSON.parse(settings.stdout)).toEqual({ defaultModel: 'm', transport: 'sse' })
  }, 60_000)

  it('a path outside the allow list is refused', async () => {
    const before = seen.length
    expect(await guestFetch('/backend-api/me', 'GET')).toBe('403')
    expect(seen.length).toBe(before)
  }, 60_000)
})
