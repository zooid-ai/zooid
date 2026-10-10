import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig, ZooidConfig } from '@zooid/core'
import { installPiExtensions } from './pi-extension-install.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zod128-pi-'))
  writeFileSync(join(dir, 'bundle.js'), '// zooid-tasks')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const agent = (name: string, over: Partial<AgentConfig> = {}): AgentConfig => ({
  name,
  workdir: `./agents/${name}`,
  hooks: {},
  acp: { preset: 'pi' } as AgentConfig['acp'],
  approval_timeout_ms: 0,
  session_idle_timeout_ms: 0,
  ...over,
})

describe('installPiExtensions (ZOD128)', () => {
  it('skips vm pi agents: their extension would dial a context socket they do not have', () => {
    const config = {
      runtime: 'local',
      agents: {
        lead: agent('lead'),
        smoke: agent('smoke', { runtime: 'vm', vm: { image: 'i' } }),
      },
      transports: {},
      hooks: {},
    } as unknown as ZooidConfig
    const lines: string[] = []
    installPiExtensions({
      config,
      configDir: dir,
      daemonHome: join(dir, 'home'),
      env: { PI_CODING_AGENT_DIR: '.pi-agent' },
      bundlePath: join(dir, 'bundle.js'),
      log: (l) => lines.push(l),
    })
    expect(existsSync(join(dir, 'agents', 'lead', '.pi-agent', 'extensions', 'zooid-tasks.js'))).toBe(true)
    expect(existsSync(join(dir, 'agents', 'smoke', '.pi-agent', 'extensions', 'zooid-tasks.js'))).toBe(false)
    expect(lines).toContain('[pi] agent=smoke status=skipped reason=runtime-vm')
    expect(lines.some((l) => l.startsWith('[pi] agent=lead ') && l.includes('status=installed'))).toBe(true)
  })
})
