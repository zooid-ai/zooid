import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig, ZooidConfig } from '@zooid/core'
import { PRESETS } from '@zooid/acp-client'
import { buildForwarderArgv, vmMachineName, type VmExec, type VmExecResult } from '@zooid/runtime-vm'
import { credentialSocketPath } from './cred-proxy/socket-path.js'
import type { startCredentialProxy } from './cred-proxy/proxy.js'
import { provisionVms } from './provision-vms.js'

let configDir: string
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'zod109-prov-'))
  for (const n of ['lead', 'smoke']) mkdirSync(join(configDir, 'agents', n), { recursive: true })
})
afterEach(() => rmSync(configDir, { recursive: true, force: true }))

function agent(name: string, over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    workdir: `./agents/${name}`,
    hooks: {},
    acp: { command: 'node', args: ['agent.mjs'] },
    approval_timeout_ms: 0,
    session_idle_timeout_ms: 0,
    http: { transport: 'http-local' },
    ...over,
  }
}

const config = (): ZooidConfig =>
  ({
    runtime: 'local',
    transports: { 'http-local': { type: 'http', port: 8080 } },
    agents: {
      lead: agent('lead'),
      smoke: agent('smoke', { runtime: 'vm', vm: { image: 'node:22-alpine', memory_mib: 1024 } }),
    },
    hooks: {},
  }) as ZooidConfig

function fakeExec() {
  const calls: string[][] = []
  const exec: VmExec = vi.fn(async (cmd, args) => {
    calls.push([cmd, ...args])
    return { code: 0, stdout: args[1] === 'ls' ? '[]' : '', stderr: '' }
  })
  return { exec, calls }
}

describe('provisionVms', () => {
  it('creates and starts one machine per vm agent, with the absolute workdir mounted read-only', async () => {
    const { exec, calls } = fakeExec()
    const handle = await provisionVms({
      cfg: config(),
      configDir,
      agentsDir: join(configDir, '.data', 'agents'),
      exec,
      log: () => {},
    })
    const name = vmMachineName('smoke', configDir)
    expect(handle.machines).toEqual([name])
    const create = calls.find((c) => c[2] === 'create')!
    expect(create).toContain(name)
    expect(create).toContain(`${join(configDir, 'agents', 'smoke')}:/workspace:ro`)
    expect(create).toContain('--mem')
    expect(calls.some((c) => c[2] === 'start')).toBe(true)
  })

  it('touches nothing when no agent resolves to vm', async () => {
    const { exec, calls } = fakeExec()
    const c = config()
    delete c.agents.smoke
    const handle = await provisionVms({ cfg: c, configDir, exec, log: () => {} })
    expect(handle.machines).toEqual([])
    expect(calls).toEqual([])
  })

  it('stop() stops every provisioned machine', async () => {
    const { exec, calls } = fakeExec()
    const handle = await provisionVms({ cfg: config(), configDir, exec, log: () => {} })
    calls.length = 0
    await handle.stop()
    expect(calls).toEqual([['smolvm', 'machine', 'stop', '--name', vmMachineName('smoke', configDir)]])
  })

  it('fails daemon start when a vm workdir holds secrets', async () => {
    writeFileSync(join(configDir, 'agents', 'smoke', '.env'), 'TOKEN=x')
    const { exec } = fakeExec()
    await expect(provisionVms({ cfg: config(), configDir, exec, log: () => {} })).rejects.toThrow(/\.env/)
  })
})

describe('provisionVms — credential proxy, egress and local images (ZOD128)', () => {
  type Rec = { name: string; state: string }
  const guestSetup = PRESETS.pi.vmCredential!.guestSetup
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zod128-home-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const piSmoke = (vm: AgentConfig['vm'] = {}) =>
    agent('smoke', {
      runtime: 'vm',
      acp: { preset: 'pi' } as AgentConfig['acp'],
      vm: { image: 'node:22-alpine', allow_hosts: ['github.com'], ...vm },
    })
  const cfgWith = (smoke: AgentConfig): ZooidConfig => ({ ...config(), agents: { lead: agent('lead'), smoke } })

  function recorder(machines: Rec[] = [], fail?: (args: string[]) => VmExecResult | undefined) {
    const events: string[] = []
    const calls: string[][] = []
    const exec: VmExec = vi.fn(async (_cmd, args) => {
      calls.push(args)
      const failed = fail?.(args)
      if (failed) return failed
      const [, sub] = args
      const name = args[args.indexOf('--name') + 1]!
      events.push(sub === 'exec' ? `exec:${args.slice(args.indexOf('--') + 1, args.indexOf('--') + 3).join(' ')}` : sub!)
      if (sub === 'ls') return { code: 0, stdout: JSON.stringify(machines), stderr: '' }
      if (sub === 'create') machines.push({ name, state: 'stopped' })
      if (sub === 'start') machines.find((m) => m.name === name)!.state = 'running'
      if (sub === 'delete') machines.splice(machines.findIndex((m) => m.name === name), 1)
      return { code: 0, stdout: '', stderr: '' }
    })
    const closes: string[] = []
    const startProxy = vi.fn(async (o: Parameters<typeof startCredentialProxy>[0]) => {
      events.push('proxy')
      return {
        socketPath: o.socketPath,
        close: vi.fn(async () => {
          closes.push(o.socketPath)
          events.push('proxy-close')
        }),
      }
    })
    return { exec, calls, events, startProxy, closes }
  }

  const run = (c: ZooidConfig, r: ReturnType<typeof recorder>) =>
    provisionVms({
      cfg: c,
      configDir,
      agentsDir: join(configDir, '.data', 'agents'),
      daemonHome: home,
      exec: r.exec,
      startProxy: r.startProxy as unknown as typeof startCredentialProxy,
      log: () => {},
    })

  it('starts the proxy and mounts its socket into a pi vm agent with the allowlisted network', async () => {
    const r = recorder()
    await run(cfgWith(piSmoke()), r)
    const sock = credentialSocketPath(configDir, 'smoke')
    expect(r.startProxy).toHaveBeenCalledTimes(1)
    const o = r.startProxy.mock.calls[0]![0]
    expect(o).toMatchObject({ socketPath: sock, upstream: 'https://chatgpt.com', allowPaths: ['/backend-api/codex/'], agent: 'smoke' })
    const create = r.calls.find((c) => c[1] === 'create')!.join(' ')
    expect(create).toContain(`--net --allow-host github.com --mount-socket ${sock}:/run/zooid/model.sock`)
  })

  it('the proxy reads the dedicated login under the daemon home', async () => {
    const r = recorder()
    await run(cfgWith(piSmoke()), r)
    const { auth } = r.startProxy.mock.calls[0]![0]
    // A missing login surfaces as the expired-login error naming the file.
    await expect(auth.current()).rejects.toThrow(join(home, '.zooid', 'cred-proxy', 'pi', 'auth.json'))
  })

  it('orders proxy → create → start → guest setup → forwarder', async () => {
    const r = recorder()
    await run(cfgWith(piSmoke()), r)
    // exec:sleep 1 is ensureVmMachine settling a networked machine (smolvm kills the first exec).
    expect(r.events).toEqual(['proxy', 'ls', 'create', 'start', 'exec:sleep 1', 'exec:sh -c', 'exec:node -e'])
    const m = vmMachineName('smoke', configDir)
    expect(r.calls).toContainEqual(['machine', 'exec', '--name', m, '--', 'sh', '-c', guestSetup])
    expect(r.calls).toContainEqual(buildForwarderArgv(m, 8787, '/run/zooid/model.sock'))
  })

  it('reruns the guest setup and forwarder on an already-running machine', async () => {
    const machines: Rec[] = []
    await run(cfgWith(piSmoke()), recorder(machines))
    const r = recorder(machines)
    await run(cfgWith(piSmoke()), r)
    expect(r.events).toEqual(['proxy', 'ls', 'exec:sh -c', 'exec:node -e'])
  })

  it('a vm agent without a credential preset gets the network but no proxy, socket or setup', async () => {
    const r = recorder()
    await run(cfgWith(agent('smoke', { runtime: 'vm', vm: { image: 'node:22-alpine', allow_hosts: ['github.com'] } })), r)
    expect(r.startProxy).not.toHaveBeenCalled()
    const create = r.calls.find((c) => c[1] === 'create')!
    expect(create).toContain('--net')
    expect(create).not.toContain('--mount-socket')
    const execs = r.calls.filter((c) => c[1] === 'exec').map((c) => c.slice(c.indexOf('--') + 1))
    expect(execs).toEqual([['sleep', '1']])
  })

  it('resolves a local image against the config dir and recreates the machine when it is rebuilt', async () => {
    const img = join(configDir, 'img.tar')
    writeFileSync(img, 'v1')
    utimesSync(img, 1000, 1000)
    const machines: Rec[] = []
    const first = recorder(machines)
    await run(cfgWith(piSmoke({ image: './img.tar' })), first)
    expect(first.calls.find((c) => c[1] === 'create')).toEqual(expect.arrayContaining(['--image', img]))
    utimesSync(img, 2000, 2000)
    const second = recorder(machines)
    await run(cfgWith(piSmoke({ image: './img.tar' })), second)
    const subs = second.calls.map((c) => c[1])
    expect(subs.indexOf('delete')).toBeGreaterThan(-1)
    expect(second.calls.find((c) => c[1] === 'delete')).toContain('--force')
    expect(subs.indexOf('create')).toBeGreaterThan(subs.indexOf('delete'))
  })

  it('fails early on a missing local image, before smolvm or the proxy', async () => {
    const r = recorder()
    await expect(run(cfgWith(piSmoke({ image: '~/missing.tar' })), r)).rejects.toThrow(
      `vm image ${join(home, 'missing.tar')} does not exist`,
    )
    expect(r.calls).toEqual([])
    expect(r.startProxy).not.toHaveBeenCalled()
  })

  it('stop() stops the machines, then closes the proxies', async () => {
    const r = recorder()
    const handle = await run(cfgWith(piSmoke()), r)
    r.events.length = 0
    await handle.stop()
    expect(r.events).toEqual(['stop', 'proxy-close'])
  })

  it('a failed guest setup names the agent and stderr, and closes the proxy', async () => {
    const r = recorder([], (args) =>
      args[1] === 'exec' && args.includes('sh') ? { code: 1, stdout: '', stderr: 'boom' } : undefined,
    )
    await expect(run(cfgWith(piSmoke()), r)).rejects.toThrow(/smoke[\s\S]*boom/)
    expect(r.closes).toEqual([credentialSocketPath(configDir, 'smoke')])
  })
})
