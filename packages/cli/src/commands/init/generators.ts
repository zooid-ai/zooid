export interface ZooidYamlOpts {
  preset: 'claude' | 'codex' | 'opencode'
  /**
   * Optional model pin. Omitted by default — the harness picks its own current
   * default. Only set when the user passes `--model` (claude / codex); opencode
   * reads its own opencode.json.
   */
  model?: string
}

export function generateZooidYaml(opts: ZooidYamlOpts): string {
  // No model by default: the harness chooses. A `--model` pin (claude/codex
  // only) expands the block to carry it.
  const acpBlock =
    opts.preset === 'opencode' || !opts.model
      ? `    acp: { preset: ${opts.preset} }`
      : `    acp:\n      preset: ${opts.preset}\n      model: ${opts.model}`
  return `runtime: local
workstation: dev

# This daemon connects in push mode: the homeserver reaches the listener on
# \`port\` below. To run it against a homeserver it can't open a port to —
# e.g. on your laptop, behind NAT — switch to pull mode: set \`mode: client\`
# under transports.matrix and drop \`port\`. Agents are reachable either way.

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

## Stack facts

- **Tuwunel** is a lightweight Rust Matrix homeserver (Conduit fork) backed by RocksDB. Single binary, low resource floor — not "heavy" for typical workforces.
- **Logs land on disk** in \`./data/\` inside this zooid home dir: tuwunel logs, the daemon, and each agent's ACP stream. Use \`zooid logs <source>\` to tail them (sources: \`tuwunel\`, \`daemon\`, \`dev\`, \`agent-<name>\`, \`agent-<name>.acp\`). Debugging is mostly "read the log file" — don't tell the operator it's opaque.

## Behavior

- Be terse. Give the answer; link to the doc page; stop.
- When the operator asks how to do something, prefer to fetch the relevant docs section over guessing from training data.
- When the operator asks you to *configure* something, propose a yaml edit and let them apply it. Don't write files directly unless they ask.
`
}

/**
 * Claude Code auto-loads `CLAUDE.md`, not `AGENTS.md`. We keep `AGENTS.md`
 * as the canonical content (codex / opencode read it directly) and ship a
 * one-line `CLAUDE.md` that pulls it in via Claude Code's `@<path>` import.
 */
export function generateClaudeMd(): string {
  return `@AGENTS.md\n`
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
          provider: { TODO: { options: {} } },
        },
        null,
        2,
      ) + '\n'
    )
  }
  // No `model` by default — opencode picks its own default. A `--model` pin
  // writes the `provider/model` route.
  const cfg: Record<string, unknown> = { $schema: 'https://opencode.ai/config.json' }
  if (opts.model) cfg.model = `${opts.provider}/${opts.model}`
  cfg.provider = {
    [opts.provider]: {
      options: { apiKey: `{env:${opts.apiKeyEnvVar}}` },
    },
  }
  cfg.permission = { webfetch: 'allow' as const }
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
