// Registry of ACP agent presets. Each preset maps a short name (e.g. "claude")
// to the command + args needed to spawn that harness as an ACP agent.
//
// Categories:
//   - ACP-native: invoked with a flag (opencode, cline, kiro, gemini)
//   - Vendored shim: invoked via npx (claude, codex)
//
// See epics/002-ZOD019-acp-runtime/SPEC.md §"Agent compatibility matrix".

export interface PresetSpec {
  command: string
  args: string[]
}

const PRESETS_INTERNAL = {
  opencode: { command: 'opencode', args: ['acp'] },
  cline: { command: 'cline', args: ['--acp'] },
  kiro: { command: 'kiro', args: ['--acp'] },
  gemini: { command: 'gemini', args: ['--acp'] },
  claude: { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
  codex: { command: 'npx', args: ['-y', '@zed-industries/codex-acp'] },
} as const satisfies Record<string, PresetSpec>

export type PresetName = keyof typeof PRESETS_INTERNAL

export const PRESETS: Record<PresetName, PresetSpec> = Object.freeze(
  Object.fromEntries(
    (Object.keys(PRESETS_INTERNAL) as PresetName[]).map((k) => [
      k,
      { command: PRESETS_INTERNAL[k].command, args: [...PRESETS_INTERNAL[k].args] },
    ]),
  ),
) as Record<PresetName, PresetSpec>

export function isPreset(name: string): name is PresetName {
  return Object.prototype.hasOwnProperty.call(PRESETS_INTERNAL, name)
}

export interface ResolvePresetOpts {
  /** Optional model string. Forwarded to the underlying shim as a `--model`
   * flag where supported. Ignored for `opencode` (model lives in opencode.json). */
  model?: string
}

// null = preset has its own model channel (opencode reads opencode.json); undefined = not implemented yet.
const MODEL_FLAG_PER_PRESET: Partial<Record<PresetName, string | null>> = {
  claude: '--model',
  codex: '--model',
  opencode: null,
}

export function resolvePreset(name: string, opts: ResolvePresetOpts = {}): PresetSpec {
  if (!isPreset(name)) {
    const known = Object.keys(PRESETS_INTERNAL).sort().join(', ')
    throw new Error(`unknown ACP preset "${name}". Known presets: ${known}`)
  }
  const entry = PRESETS_INTERNAL[name]
  const args: string[] = [...entry.args]
  if (opts.model !== undefined) {
    const flag = MODEL_FLAG_PER_PRESET[name]
    if (flag) args.push(flag, opts.model)
  }
  return { command: entry.command, args }
}
