import { select, password } from '@inquirer/prompts'
import { findOpencodeProvider, findSimplePreset } from './registry.js'
import type { InitOptions } from '../init.js'

export interface PromptInput {
  dir: string
  preset?: string
  auth?: string
  model?: string
  provider?: string
  apiKey?: string
  force?: boolean
  overwrite?: boolean
  interactive?: boolean
}

export async function resolveOptions(flags: PromptInput): Promise<InitOptions> {
  const interactive = flags.interactive !== false && Boolean(process.stdin.isTTY)
  const ask = <T>(prompt: () => Promise<T>, fallback: () => string): Promise<T> => {
    if (!interactive) return Promise.reject(new Error(fallback()))
    return prompt()
  }

  const preset = (flags.preset as InitOptions['preset']) ?? (await ask(
    () => select({
      message: 'Which agent should zooid-assistant use?',
      choices: [
        { name: 'claude (Claude Code)', value: 'claude' as const },
        { name: 'codex (OpenAI Codex)', value: 'codex' as const },
        { name: 'opencode', value: 'opencode' as const },
      ],
    }),
    () => '--preset is required (claude | codex | opencode)',
  ))

  if (preset === 'opencode') {
    // The interactive wizard never asks which provider/model — it defaults to
    // opencode-go (the recommended subscription) and just collects the API key.
    // Other providers and a pinned model are reachable via --provider / --model.
    const provider = flags.provider ?? 'opencode-go'
    if (provider === 'custom') {
      return {
        dir: flags.dir,
        preset,
        provider,
        force: flags.force,
        overwrite: flags.overwrite,
      }
    }
    const meta = findOpencodeProvider(provider)
    if (!meta) throw new Error(`unknown opencode provider: ${provider}`)
    const apiKey = flags.apiKey ?? (await ask(
      () => password({ message: `${meta.label} API key:` }),
      () => '--api-key is required',
    ))
    return {
      dir: flags.dir,
      preset,
      provider,
      model: flags.model,
      apiKey,
      force: flags.force,
      overwrite: flags.overwrite,
    }
  }

  const meta = findSimplePreset(preset)
  if (!meta) throw new Error(`unknown preset: ${preset}`)
  const auth = (flags.auth as 'subscription' | 'api-key') ?? (await ask(
    () => select({
      message: 'How do you authenticate?',
      choices: [
        { name: `My ${meta.subscriptionLabel}`, value: 'subscription' as const },
        { name: `I'll provide an API key`, value: 'api-key' as const },
      ],
    }),
    () => '--auth is required (subscription | api-key)',
  ))
  // No model prompt — Claude Code / Codex use their own current default.
  // `--model` pins one for those who want it.
  const apiKey =
    auth === 'api-key'
      ? flags.apiKey ?? (await ask(
          () => password({ message: `${meta.apiKeyPromptLabel} API key:` }),
          () => '--api-key is required when --auth=api-key',
        ))
      : undefined

  return {
    dir: flags.dir,
    preset,
    auth,
    model: flags.model,
    apiKey,
    force: flags.force,
    overwrite: flags.overwrite,
  }
}
