export interface SimplePresetMeta {
  preset: 'claude' | 'codex'
  models: string[]
  subscriptionLabel: string
  apiKeyEnvVar: string
  apiKeyPromptLabel: string
  /** Home-relative directory checked on the subscription sniff (existence only). */
  credentialDir: string
}

export const SIMPLE_PRESETS: readonly SimplePresetMeta[] = [
  {
    preset: 'claude',
    models: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5'],
    subscriptionLabel: 'Claude subscription (Pro / Max / Team / Enterprise)',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    apiKeyPromptLabel: 'Anthropic',
    credentialDir: '.claude',
  },
  {
    preset: 'codex',
    models: ['gpt-5.5'],
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
  models: string[]
  apiKeyEnvVar: string
}

export const OPENCODE_PROVIDERS: readonly OpencodeProviderMeta[] = [
  {
    id: 'opencode-go',
    label: 'opencode-go',
    description: '$10/mo subscription — Kimi, GLM, MiniMax',
    models: ['kimi-k2.6', 'kimi-k2.5', 'glm-5.1', 'glm-5', 'minimax-m2.7'],
    apiKeyEnvVar: 'OPENCODE_API_KEY',
  },
  {
    id: 'opencode',
    label: 'opencode (Zen)',
    description: 'free tier — curated models',
    models: ['kimi-k2.5-free', 'glm-4.7-free', 'minimax-m2.1-free'],
    apiKeyEnvVar: 'OPENCODE_API_KEY',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude via direct Anthropic API',
    models: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5'],
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'many providers via OpenRouter',
    models: ['anthropic/claude-sonnet-4-6', 'zhipuai/glm-5', 'moonshot/kimi-k2.6'],
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
  },
]

export function findSimplePreset(name: string): SimplePresetMeta | undefined {
  return SIMPLE_PRESETS.find((p) => p.preset === name)
}

export function findOpencodeProvider(id: string): OpencodeProviderMeta | undefined {
  return OPENCODE_PROVIDERS.find((p) => p.id === id)
}
