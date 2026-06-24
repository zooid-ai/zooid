import { describe, it, expect } from 'vitest'
import {
  generateZooidYaml,
  generateAgentsMd,
  generateClaudeSettings,
  generateOpencodeJson,
  generateEnv,
  generateGitignore,
} from './generators.js'

describe('generateZooidYaml', () => {
  it('produces the short shape for claude with NO model (harness default)', () => {
    const out = generateZooidYaml({ preset: 'claude' })
    expect(out).toContain('runtime: local')
    expect(out).toContain('workstation: dev')
    expect(out).toContain('homeserver: http://localhost:8448')
    expect(out).toContain('port: 9099')
    expect(out).toContain('zooid-assistant:')
    expect(out).toContain('acp: { preset: claude }')
    expect(out).toContain("display_name: 'Zooid Assistant'")
    expect(out).toContain("rooms: ['#zooid']")
    expect(out).not.toContain('model:')
    expect(out).not.toContain('user_id:')
    expect(out).not.toContain('workdir:')
    expect(out).not.toContain('transport: matrix')
  })

  it('expands the acp block to carry a model only when one is pinned', () => {
    const out = generateZooidYaml({ preset: 'claude', model: 'claude-opus-4-8' })
    expect(out).toContain('preset: claude')
    expect(out).toContain('model: claude-opus-4-8')
  })

  it('includes a comment pointing at pull mode for remote/NAT setups', () => {
    const out = generateZooidYaml({ preset: 'claude' })
    expect(out).toContain('mode: client')
    expect(out).toMatch(/pull mode/i)
  })

  it('omits model on the acp block for opencode (model lives in opencode.json)', () => {
    const out = generateZooidYaml({ preset: 'opencode' })
    expect(out).toContain('acp: { preset: opencode }')
    expect(out).not.toContain('model:')
  })
})

describe('generateClaudeMd', () => {
  it('imports AGENTS.md via the @<path> directive Claude Code auto-loads', async () => {
    const { generateClaudeMd } = await import('./generators.js')
    expect(generateClaudeMd().trim()).toBe('@AGENTS.md')
  })
})

describe('generateAgentsMd', () => {
  it('names the assistant and points at the docs URL', () => {
    const out = generateAgentsMd()
    expect(out).toContain('zooid-assistant')
    expect(out).toContain('https://zooid.dev/docs/')
    expect(out).toContain('web fetch')
  })
})

describe('generateClaudeSettings', () => {
  it('emits a settings.json that allowlists WebFetch(domain:zooid.dev)', () => {
    const out = generateClaudeSettings()
    const parsed = JSON.parse(out)
    expect(parsed.permissions.allow).toContain('WebFetch(domain:zooid.dev)')
  })
})

describe('generateOpencodeJson', () => {
  it('omits model by default (opencode picks its own) but keeps provider + apiKey', () => {
    const out = generateOpencodeJson({
      provider: 'opencode-go',
      apiKeyEnvVar: 'OPENCODE_API_KEY',
    })
    const parsed = JSON.parse(out)
    expect(parsed).not.toHaveProperty('model')
    expect(parsed.provider['opencode-go'].options.apiKey).toBe('{env:OPENCODE_API_KEY}')
    expect(parsed.permission.webfetch).toBe('allow')
  })

  it('writes provider/model only when a model is pinned', () => {
    const out = generateOpencodeJson({
      provider: 'opencode-go',
      model: 'kimi-k2.6',
      apiKeyEnvVar: 'OPENCODE_API_KEY',
    })
    expect(JSON.parse(out).model).toBe('opencode-go/kimi-k2.6')
  })

  it('produces a model-less TODO stub for the custom provider', () => {
    const out = generateOpencodeJson({ provider: 'custom' })
    const parsed = JSON.parse(out)
    expect(parsed).not.toHaveProperty('model')
    expect(parsed.provider).toHaveProperty('TODO')
  })
})

describe('generateEnv', () => {
  it('emits a single line with the right env var name', () => {
    expect(generateEnv({ envVar: 'ANTHROPIC_API_KEY', value: 'sk-ant-x' })).toBe(
      'ANTHROPIC_API_KEY=sk-ant-x\n',
    )
  })
})

describe('generateGitignore', () => {
  it('ignores .env, node_modules, and data/', () => {
    const out = generateGitignore()
    expect(out).toContain('.env')
    expect(out).toContain('node_modules/')
    expect(out).toContain('data/')
  })
})
