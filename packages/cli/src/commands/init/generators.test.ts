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
  it('produces the short post-ZOD048 shape for claude + model', () => {
    const out = generateZooidYaml({
      preset: 'claude',
      model: 'claude-sonnet-4-6',
    })
    expect(out).toContain('runtime: local')
    expect(out).toContain('homeserver: http://localhost:8448')
    expect(out).toContain('port: 9099')
    expect(out).toContain('zooid-assistant:')
    expect(out).toContain('preset: claude')
    expect(out).toContain('model: claude-sonnet-4-6')
    expect(out).toContain("display_name: 'Zooid Assistant'")
    expect(out).toContain("rooms: ['#zooid']")
    expect(out).not.toContain('user_id:')
    expect(out).not.toContain('workdir:')
    expect(out).not.toContain('transport: matrix')
  })

  it('omits model on the acp block for opencode (model lives in opencode.json)', () => {
    const out = generateZooidYaml({ preset: 'opencode' })
    expect(out).toContain('acp: { preset: opencode }')
    expect(out).not.toContain('model:')
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
  it('produces opencode-go/<model> with the OPENCODE_API_KEY env reference', () => {
    const out = generateOpencodeJson({
      provider: 'opencode-go',
      model: 'kimi-k2.6',
      apiKeyEnvVar: 'OPENCODE_API_KEY',
    })
    const parsed = JSON.parse(out)
    expect(parsed.model).toBe('opencode-go/kimi-k2.6')
    expect(parsed.provider['opencode-go'].options.apiKey).toBe('{env:OPENCODE_API_KEY}')
    expect(parsed.permission.webfetch).toBe('allow')
  })

  it('produces a TODO stub for the custom provider', () => {
    const out = generateOpencodeJson({ provider: 'custom' })
    const parsed = JSON.parse(out)
    expect(parsed.model).toMatch(/TODO/)
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
