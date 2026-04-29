import { describe, it, expect } from 'vitest'
import { loadConfig, type AgentAdapter } from '@zooid/budd-core'
import { resolveEnvPassthrough } from '@zooid/budd-runtime-docker'
import { buildRunnersFromConfig } from './index.js'

// Stub adapter mirrors the shape the opencode factory will produce: a
// per-instance envPassthrough computed from options.
function makeStubFactory(envPassthrough: string[]) {
  return (_opts: Record<string, unknown>): AgentAdapter => ({
    name: 'stub',
    envPassthrough,
    isAvailable: () => true,
    prepareNewSession: () => ({ strategy: 'preassigned' as const, session_id: 'x' }),
    spawn: () => ({ command: 'true', args: [] }),
  })
}

describe('forward_env end-to-end (parser → runner → env resolution)', () => {
  it('adapter list + forward_env merge correctly with rename', () => {
    const config = loadConfig(`
transport: http
runtime: docker
docker: { image: stub:latest }
agents:
  triage:
    workdir: .
    adapter:
      type: stub
      options: { model: anthropic/x }
    docker:
      image: stub:latest
      forward_env:
        - JIRA_URL
        - CORP_JIRA_TOKEN:JIRA_TOKEN
`)
    const adapters = { stub: makeStubFactory(['ANTHROPIC_API_KEY']) }
    const runners = buildRunnersFromConfig(config, { adapters })
    const adapter = runners.triage.adapter
    const forwardEnv = config.agents.triage.docker?.forward_env

    const resolved = resolveEnvPassthrough(adapter, forwardEnv, {
      ANTHROPIC_API_KEY: 'sk-a',
      JIRA_URL: 'https://j',
      CORP_JIRA_TOKEN: 'tok',
      BUDD_TOKEN: 'must-not-leak',
    })

    expect(resolved).toEqual([
      ['ANTHROPIC_API_KEY', 'sk-a'],
      ['JIRA_TOKEN', 'tok'],
      ['JIRA_URL', 'https://j'],
    ])
    // BUDD_TOKEN deny-list invariant is the most important non-leak guarantee.
    expect(resolved.find(([k]) => k.startsWith('BUDD'))).toBeUndefined()
  })

  it('agent without forward_env still gets the adapter-declared list', () => {
    const config = loadConfig(`
transport: http
runtime: docker
docker: { image: stub:latest }
agents:
  qa:
    workdir: .
    adapter: claude
    docker: { image: ghcr.io/zooid-ai/budd-agent-claude-code:latest }
`)
    const runners = buildRunnersFromConfig(config)
    const adapter = runners.qa.adapter
    const forwardEnv = config.agents.qa.docker?.forward_env // undefined

    const resolved = resolveEnvPassthrough(adapter, forwardEnv, {
      ANTHROPIC_API_KEY: 'sk-a',
      OTHER_VAR: 'leave-me',
    })

    expect(resolved).toEqual([['ANTHROPIC_API_KEY', 'sk-a']])
  })
})
