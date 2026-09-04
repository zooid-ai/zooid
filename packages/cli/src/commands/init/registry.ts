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

export interface PiProviderMeta {
  id: string
  label: string
  description: string
  apiKeyEnvVar: string
}

// ZOD075. pi is multi-provider like opencode, but unlike opencode it also has an
// OAuth subscription tier (Claude Pro/Max, ChatGPT Plus/Pro, xAI, OpenRouter)
// whose tokens live in ~/.pi/agent/auth.json — which is why pi gets its own
// branch instead of a SIMPLE_PRESETS row.
export const PI_PROVIDERS: readonly PiProviderMeta[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'many providers via OpenRouter credits',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude via direct Anthropic API key',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT via direct OpenAI API key',
    apiKeyEnvVar: 'OPENAI_API_KEY',
  },
]

// The ONE pinned model in this wizard, and a deliberate exception to the rule at
// the top of this file. Every other harness picks its own current default; pi's
// resolved to a model that returned an empty turn (ZOD073), so pi must be told.
//
// Not anthropic: pi bills Claude Pro/Max through "extra usage" (per-token, NOT
// against the plan), which starts at zero — so a claude default returns
// `400 "You're out of extra usage"` for the operator most likely to try Zooid,
// and ACP surfaces that as silence. openrouter/deepseek-v4-pro is the verified
// fallback; an operator's own global pair is preferred over it (sniffPiDefaults).
export const PI_DEFAULT_PROVIDER = 'openrouter'
export const PI_DEFAULT_MODEL = 'deepseek/deepseek-v4-pro'

/** Agent dir, relative so one value is right under both local and container runtimes. */
export const PI_AGENT_DIR = '.pi-agent'
/** Home-relative paths to the operator's real pi install. */
export const PI_AUTH_FILE = '.pi/agent/auth.json'
export const PI_SETTINGS_FILE = '.pi/agent/settings.json'

// pi's auth surface is the union of the two existing shapes: opencode's
// provider table plus claude/codex's subscription-or-api-key binary.
export const PI_AUTH_MODES = ['subscription', 'api-key'] as const

export function findPiProvider(id: string): PiProviderMeta | undefined {
  return PI_PROVIDERS.find((p) => p.id === id)
}
