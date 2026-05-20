export interface ZooidYamlOpts {
  preset: 'claude' | 'codex' | 'opencode'
  /** Only set for claude / codex; opencode reads its own opencode.json. */
  model?: string
}

export function generateZooidYaml(opts: ZooidYamlOpts): string {
  const acpBlock =
    opts.preset === 'opencode'
      ? `    acp: { preset: opencode }`
      : `    acp:\n      preset: ${opts.preset}\n      model: ${opts.model}`
  return `runtime: local

transports:
  matrix:
    homeserver: http://localhost:8448
    port: 9099

agents:
  zooid-assistant:
${acpBlock}
    matrix:
      display_name: 'Zooid Assistant'
      rooms: ['#zooid']
`
}

export function generateAgentsMd(): string {
  return `# zooid-assistant

You are the zooid setup assistant. Your job is to help the operator get a workforce running, add agents, and configure zooid for their use case.

## Resources

- Zooid documentation: https://zooid.dev/docs/
- Use your web fetch tool to read documentation pages when answering questions.

## Behavior

- Be terse. Give the answer; link to the doc page; stop.
- When the operator asks how to do something, prefer to fetch the relevant docs section over guessing from training data.
- When the operator asks you to *configure* something, propose a yaml edit and let them apply it. Don't write files directly unless they ask.
`
}

export function generateClaudeSettings(): string {
  return (
    JSON.stringify(
      {
        permissions: {
          allow: ['WebFetch(domain:zooid.dev)'],
        },
      },
      null,
      2,
    ) + '\n'
  )
}

export interface OpencodeJsonOpts {
  provider: string
  model?: string
  apiKeyEnvVar?: string
}

export function generateOpencodeJson(opts: OpencodeJsonOpts): string {
  if (opts.provider === 'custom') {
    return (
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          model: 'TODO/your-model',
          provider: { TODO: { options: {} } },
        },
        null,
        2,
      ) + '\n'
    )
  }
  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    model: `${opts.provider}/${opts.model}`,
    provider: {
      [opts.provider]: {
        options: { apiKey: `{env:${opts.apiKeyEnvVar}}` },
      },
    },
    permission: { webfetch: 'allow' as const },
  }
  return JSON.stringify(cfg, null, 2) + '\n'
}

export interface EnvOpts {
  envVar: string
  value: string
}

export function generateEnv(opts: EnvOpts): string {
  return `${opts.envVar}=${opts.value}\n`
}

export function generateGitignore(): string {
  return ['.env', 'node_modules/', 'data/', ''].join('\n')
}

export function generateOpencodeReadme(): string {
  return `See https://opencode.ai/config for the full opencode.json schema, including
provider-specific options and per-tool permissions.
`
}
