import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig, ZooidConfig } from '@zooid/core'
import { vmMachineName, type VmExec } from '@zooid/runtime-vm'
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
