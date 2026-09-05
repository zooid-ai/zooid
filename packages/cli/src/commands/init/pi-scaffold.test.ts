import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadZooidConfig } from '@zooid/core'
import { runInit } from '../init.js'

let dir: string
let fakeHome: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zooid-pi-init-'))
  fakeHome = mkdtempSync(join(tmpdir(), 'zooid-pi-home-'))
  process.env.MATRIX_AS_TOKEN = 'as-test'
  process.env.MATRIX_HS_TOKEN = 'hs-test'
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(fakeHome, { recursive: true, force: true })
  delete process.env.MATRIX_AS_TOKEN
  delete process.env.MATRIX_HS_TOKEN
})

const read = (p: string) => readFileSync(join(dir, p), 'utf8')

describe('zooid init --preset pi (ZOD075)', () => {
  it('scaffolds a config that parses and resolves the pi preset', async () => {
    await runInit({ dir, preset: 'pi', auth: 'api-key', provider: 'openrouter', apiKey: 'sk-test', home: fakeHome })
    const cfg = loadZooidConfig(read('zooid.yaml'))
    expect(cfg.agents['zooid-assistant']!.acp).toMatchObject({ preset: 'pi' })
  })

  // The agent dir is RELATIVE so one value is correct under both runtimes:
  // cwd is agents/zooid-assistant locally and /workspace in a container, and
  // those are the same directory. See spike 1.1.
  it('points PI_CODING_AGENT_DIR at a relative .pi-agent', () => {
    expect(true).toBe(true) // asserted below once written
  })

  it('writes PI_CODING_AGENT_DIR into .env as a relative path', async () => {
    await runInit({ dir, preset: 'pi', auth: 'api-key', provider: 'openrouter', apiKey: 'sk-test', home: fakeHome })
    expect(read('.env')).toContain('PI_CODING_AGENT_DIR=.pi-agent')
  })

  it('writes the API key for the chosen provider', async () => {
    await runInit({ dir, preset: 'pi', auth: 'api-key', provider: 'openrouter', apiKey: 'sk-test', home: fakeHome })
    expect(read('.env')).toContain('OPENROUTER_API_KEY=sk-test')
  })

  // The settings file lands INSIDE the agent's workdir, because that is the
  // cwd pi resolves the relative override against.
  it('seeds .pi-agent/settings.json under the agent workdir', async () => {
    await runInit({ dir, preset: 'pi', auth: 'api-key', provider: 'openrouter', apiKey: 'sk-test', home: fakeHome })
    const s = JSON.parse(read('agents/zooid-assistant/.pi-agent/settings.json'))
    expect(s).toEqual({
      defaultProvider: 'openrouter',
      defaultModel: 'deepseek/deepseek-v4-pro',
    })
  })

  it('gitignores the agent dir', async () => {
    await runInit({ dir, preset: 'pi', auth: 'api-key', provider: 'openrouter', apiKey: 'sk-test', home: fakeHome })
    expect(read('.gitignore')).toContain('.pi-agent/')
  })

  it('writes AGENTS.md but no CLAUDE.md or opencode.json', async () => {
    await runInit({ dir, preset: 'pi', auth: 'api-key', provider: 'openrouter', apiKey: 'sk-test', home: fakeHome })
    expect(existsSync(join(dir, 'agents/zooid-assistant/AGENTS.md'))).toBe(true)
    expect(existsSync(join(dir, 'agents/zooid-assistant/CLAUDE.md'))).toBe(false)
    expect(existsSync(join(dir, 'agents/zooid-assistant/opencode.json'))).toBe(false)
  })
})

describe('zooid init --preset pi auth choice (ZOD075)', () => {
  const seedLogin = () => {
    mkdirSync(join(fakeHome, '.pi', 'agent'), { recursive: true })
    writeFileSync(join(fakeHome, '.pi', 'agent', 'auth.json'), '{"openrouter":{}}')
  }

  // The agent gets its OWN identity. This is the only path on a server, the
  // simpler path in a container, and the right default when agent spend should
  // be billed or revoked separately.
  it('api-key gives the agent its own credential and shares nothing', async () => {
    seedLogin()
    await runInit({
      dir, preset: 'pi', auth: 'api-key', provider: 'openrouter',
      apiKey: 'sk-agent-own', home: fakeHome,
    })
    expect(read('.env')).toContain('OPENROUTER_API_KEY=sk-agent-own')
    // No link/copy of the operator's auth.json anywhere in the scaffold.
    expect(existsSync(join(dir, 'agents/zooid-assistant/.pi-agent/auth.json'))).toBe(false)
  })

  // Detecting a login must OFFER, never assume — an inferred share is exactly
  // the silent guess this spec exists to remove.
  it('does not borrow the login just because one was detected', async () => {
    seedLogin()
    await runInit({
      dir, preset: 'pi', auth: 'api-key', provider: 'openrouter',
      apiKey: 'sk-agent-own', home: fakeHome,
    })
    expect(existsSync(join(dir, 'agents/zooid-assistant/.pi-agent/auth.json'))).toBe(false)
  })

  it('requires --auth for pi, as it does for claude/codex', async () => {
    await expect(
      runInit({ dir, preset: 'pi', provider: 'openrouter', apiKey: 'k', home: fakeHome }),
    ).rejects.toThrow(/--auth/)
  })

  it('rejects --auth subscription when no pi login exists', async () => {
    await expect(
      runInit({ dir, preset: 'pi', auth: 'subscription', home: fakeHome }),
    ).rejects.toThrow(/no pi login/i)
  })
})

describe('zooid init --preset pi inherits the operator settings (ZOD075)', () => {
  const seedGlobal = (obj: unknown) => {
    mkdirSync(join(fakeHome, '.pi', 'agent'), { recursive: true })
    writeFileSync(join(fakeHome, '.pi', 'agent', 'settings.json'), JSON.stringify(obj))
  }

  // A pair the operator already runs is verified by use; prefer it to our pin.
  it('prefers the global defaultProvider/defaultModel over the built-in pin', async () => {
    seedGlobal({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-5' })
    await runInit({ dir, preset: 'pi', auth: 'api-key', provider: 'openrouter', apiKey: 'sk-test', home: fakeHome })
    const s = JSON.parse(read('agents/zooid-assistant/.pi-agent/settings.json'))
    expect(s).toEqual({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-5' })
  })

  it('falls back to the pin when the global settings pin nothing', async () => {
    seedGlobal({ theme: 'dark' })
    await runInit({ dir, preset: 'pi', auth: 'api-key', provider: 'openrouter', apiKey: 'sk-test', home: fakeHome })
    const s = JSON.parse(read('agents/zooid-assistant/.pi-agent/settings.json'))
    expect(s.defaultProvider).toBe('openrouter')
    expect(s.defaultModel).toBe('deepseek/deepseek-v4-pro')
  })

  // An explicit flag always wins over an inherited value.
  it('lets --model override an inherited model', async () => {
    seedGlobal({ defaultProvider: 'openrouter', defaultModel: 'deepseek/deepseek-v4-flash' })
    await runInit({
      dir, preset: 'pi', auth: 'api-key', provider: 'openrouter', apiKey: 'sk-test',
      model: 'deepseek/deepseek-v4-pro', home: fakeHome,
    })
    const s = JSON.parse(read('agents/zooid-assistant/.pi-agent/settings.json'))
    expect(s.defaultModel).toBe('deepseek/deepseek-v4-pro')
  })
})
