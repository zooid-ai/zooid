import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import { runInit } from './init.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zooid-init-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function loadYaml(path: string): unknown {
  return parseYaml(readFileSync(path, 'utf8'))
}

describe('runInit — claude subscription path', () => {
  it('writes yaml + AGENTS.md + .claude/settings.json + .gitignore (no model, no .env, no opencode.json)', async () => {
    await runInit({
      dir,
      preset: 'claude',
      auth: 'subscription',
    })

    expect(existsSync(join(dir, 'zooid.yaml'))).toBe(true)
    expect(existsSync(join(dir, 'agents/zooid-assistant/AGENTS.md'))).toBe(true)
    expect(existsSync(join(dir, 'agents/zooid-assistant/CLAUDE.md'))).toBe(true)
    expect(existsSync(join(dir, 'agents/zooid-assistant/.claude/settings.json'))).toBe(true)
    expect(existsSync(join(dir, '.gitignore'))).toBe(true)
    expect(existsSync(join(dir, '.env'))).toBe(false)
    expect(existsSync(join(dir, 'agents/zooid-assistant/opencode.json'))).toBe(false)

    const cfg = loadYaml(join(dir, 'zooid.yaml')) as {
      agents: { 'zooid-assistant': { acp: { preset: string; model?: string } } }
    }
    // No model — the harness chooses its own default.
    expect(cfg.agents['zooid-assistant'].acp).toEqual({ preset: 'claude' })
  })

  it('pins a model when --model is passed', async () => {
    await runInit({ dir, preset: 'claude', auth: 'subscription', model: 'claude-opus-4-8' })
    const cfg = loadYaml(join(dir, 'zooid.yaml')) as {
      agents: { 'zooid-assistant': { acp: { preset: string; model?: string } } }
    }
    expect(cfg.agents['zooid-assistant'].acp).toEqual({
      preset: 'claude',
      model: 'claude-opus-4-8',
    })
  })
})

describe('runInit — claude api-key path', () => {
  it('also writes .env with the ANTHROPIC_API_KEY line', async () => {
    await runInit({
      dir,
      preset: 'claude',
      auth: 'api-key',
      apiKey: 'sk-ant-xyz',
    })

    expect(readFileSync(join(dir, '.env'), 'utf8').trim()).toBe('ANTHROPIC_API_KEY=sk-ant-xyz')
  })
})

describe('runInit — opencode opencode-go path', () => {
  it('writes opencode.json with opencode-go provider + env-interpolated apiKey, no model', async () => {
    await runInit({
      dir,
      preset: 'opencode',
      provider: 'opencode-go',
      apiKey: 'sk-opencode-zzz',
    })

    expect(existsSync(join(dir, 'agents/zooid-assistant/.claude'))).toBe(false)
    const oc = JSON.parse(
      readFileSync(join(dir, 'agents/zooid-assistant/opencode.json'), 'utf8'),
    )
    // No model — opencode picks its own default (e.g. bigpickle).
    expect(oc).not.toHaveProperty('model')
    expect(oc.provider['opencode-go'].options.apiKey).toBe('{env:OPENCODE_API_KEY}')
    expect(oc.permission.webfetch).toBe('allow')

    expect(readFileSync(join(dir, '.env'), 'utf8').trim()).toBe('OPENCODE_API_KEY=sk-opencode-zzz')

    const yamlCfg = loadYaml(join(dir, 'zooid.yaml')) as {
      agents: { 'zooid-assistant': { acp: unknown } }
    }
    expect(yamlCfg.agents['zooid-assistant'].acp).toEqual({ preset: 'opencode' })
  })
})

describe('runInit — idempotency', () => {
  it('errors on non-empty dir without --force', async () => {
    writeFileSync(join(dir, 'preexisting.txt'), 'x')
    await expect(
      runInit({ dir, preset: 'claude', auth: 'subscription' }),
    ).rejects.toThrow(/non-empty/i)
  })

  it('ignores package-manager files (node_modules, package.json, lockfiles, .git)', async () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}')
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
    require('node:fs').mkdirSync(join(dir, 'node_modules'))
    require('node:fs').mkdirSync(join(dir, '.git'))
    await runInit({ dir, preset: 'claude', auth: 'subscription' })
    expect(existsSync(join(dir, 'zooid.yaml'))).toBe(true)
  })

  it('preserves existing files under --force (additive create only)', async () => {
    writeFileSync(join(dir, 'zooid.yaml'), 'preexisting: true')
    await runInit({
      dir,
      preset: 'claude',
      auth: 'subscription',
      force: true,
    })
    expect(readFileSync(join(dir, 'zooid.yaml'), 'utf8')).toContain('preexisting: true')
    expect(existsSync(join(dir, 'agents/zooid-assistant/AGENTS.md'))).toBe(true)
  })

  it('overwrites under --force --overwrite', async () => {
    writeFileSync(join(dir, 'zooid.yaml'), 'preexisting: true')
    await runInit({
      dir,
      preset: 'claude',
      auth: 'subscription',
      force: true,
      overwrite: true,
    })
    expect(readFileSync(join(dir, 'zooid.yaml'), 'utf8')).not.toContain('preexisting: true')
  })
})
