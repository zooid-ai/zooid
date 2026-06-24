// Note: no model lists live here. The wizard never asks for a model — every
// harness (Claude Code, Codex, opencode) picks its own current default, so
// there's no version list to keep fresh. A specific model is a normal
// post-init edit (`model:` in zooid.yaml, or `model` in opencode.json), and
// can be pinned non-interactively via the optional `--model` flag.

export interface SimplePresetMeta {
  preset: 'claude' | 'codex'
  subscriptionLabel: string
  apiKeyEnvVar: string
  apiKeyPromptLabel: string
  /** Home-relative directory checked on the subscription sniff (existence only). */
  credentialDir: string
}

export const SIMPLE_PRESETS: readonly SimplePresetMeta[] = [
  {
    preset: 'claude',
    subscriptionLabel: 'Claude subscription (Pro / Max / Team / Enterprise)',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    apiKeyPromptLabel: 'Anthropic',
    credentialDir: '.claude',
  },
  {
    preset: 'codex',
    subscriptionLabel: 'ChatGPT subscription (Plus / Pro / Team)',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    apiKeyPromptLabel: 'OpenAI',
    credentialDir: '.codex',
  },
]

export interface OpencodeProviderMeta {
  id: string
  label: string
  description: string
  apiKeyEnvVar: string
}

// Providers are an opencode routing/auth concern, reachable via the optional
// `--provider` flag. The interactive wizard defaults to `opencode-go` (first
// entry) and only asks for the API key.
export const OPENCODE_PROVIDERS: readonly OpencodeProviderMeta[] = [
  {
    id: 'opencode-go',
    label: 'opencode-go',
    description: '$10/mo subscription — Kimi, GLM, MiniMax',
    apiKeyEnvVar: 'OPENCODE_API_KEY',
  },
  {
    id: 'opencode',
    label: 'opencode (Zen)',
    description: 'free tier — curated models',
    apiKeyEnvVar: 'OPENCODE_API_KEY',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude via direct Anthropic API',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'many providers via OpenRouter',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
  },
]

export function findSimplePreset(name: string): SimplePresetMeta | undefined {
  return SIMPLE_PRESETS.find((p) => p.preset === name)
}

export function findOpencodeProvider(id: string): OpencodeProviderMeta | undefined {
  return OPENCODE_PROVIDERS.find((p) => p.id === id)
}
