// Registry of ACP agent presets. Each preset maps a short name (e.g. "claude")
// to the command + args needed to spawn that harness as an ACP agent.
//
// Categories:
//   - ACP-native: invoked with a flag (opencode, cline, kiro, gemini)
//   - Vendored shim: invoked via npx (claude, codex)
//
// See epics/002-ZOD019-acp-runtime/SPEC.md §"Agent compatibility matrix".

export interface PresetMountContext {
  agentName: string
  /** Per-agent host state root (`<dataDir>/agents/<agentName>`). Kept on the
   *  context for forward compatibility — v1 default declarations don't use
   *  it, but presets that opt into per-agent isolation can. */
  agentDataDir: string
  /** Resolved container working directory, e.g. `/workspace`. */
  containerWorkdir: string
  /** Daemon user's `$HOME`. Source of `~/.<preset>` for the v1 `home` /
   *  `data` / `config` defaults. Threaded from `buildAcpRegistry` so tests
   *  can inject without mutating `process.env.HOME`. */
  daemonHome: string
}

export interface PresetMount {
  id: string
  host: string
  target: string
  mode: 'ro' | 'rw'
  create?: boolean
}

export interface PresetSpec {
  command: string
  args: string[]
  /**
   * Default container image for this preset. Last fallback in the
   * `buildAcpRegistry` image-resolution chain (agent > workforce > preset).
   * Omit when no first-party image is published yet.
   */
  image?: string
  /**
   * Canonical-id mounts this preset wants set up. Called once per agent
   * during registry construction with `{ agentName, agentDataDir, containerWorkdir }`.
   */
  mounts?: (ctx: PresetMountContext) => PresetMount[]
}

type PresetInternal = PresetSpec

const PRESETS_INTERNAL = {
  opencode: {
    command: 'opencode',
    args: ['acp'],
    image: 'ghcr.io/zooid-ai/agent-opencode:latest',
    mounts: (ctx: PresetMountContext): PresetMount[] => [
      {
        id: 'data',
        host: `${ctx.daemonHome}/.local/share/opencode`,
        target: '/root/.local/share/opencode',
        mode: 'rw',
        create: false,
      },
      {
        id: 'config',
        host: `${ctx.daemonHome}/.config/opencode`,
        target: '/root/.config/opencode',
        mode: 'rw',
        create: false,
      },
    ],
  },
  cline: { command: 'cline', args: ['--acp'] },
  kiro: { command: 'kiro', args: ['--acp'] },
  gemini: { command: 'gemini', args: ['--acp'] },
  claude: {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    image: 'ghcr.io/zooid-ai/agent-claude-code:latest',
    mounts: (ctx: PresetMountContext): PresetMount[] => [
      {
        id: 'home',
        host: `${ctx.daemonHome}/.claude`,
        target: '/root/.claude',
        mode: 'rw',
        create: false,
      },
    ],
  },
  codex: {
    command: 'npx',
    // web_search="live" forces live web fetches instead of codex's cached snippet
    // index, which doesn't know about recently-launched sites (e.g. zooid.dev).
    args: ['-y', '@zed-industries/codex-acp', '-c', 'web_search="live"'],
    image: 'ghcr.io/zooid-ai/agent-codex:latest',
    mounts: (ctx: PresetMountContext): PresetMount[] => [
      {
        id: 'home',
        host: `${ctx.daemonHome}/.codex`,
        target: '/root/.codex',
        mode: 'rw',
        create: false,
      },
    ],
  },
} as const satisfies Record<string, PresetInternal>

export type PresetName = keyof typeof PRESETS_INTERNAL

export const PRESETS: Record<PresetName, PresetSpec> = Object.freeze(
  Object.fromEntries(
    (Object.keys(PRESETS_INTERNAL) as PresetName[]).map((k) => {
      const e = PRESETS_INTERNAL[k]
      const copy: PresetSpec = { command: e.command, args: [...e.args] }
      if ('image' in e && e.image) copy.image = e.image
      if ('mounts' in e && typeof e.mounts === 'function') {
        copy.mounts = e.mounts as PresetSpec['mounts']
      }
      return [k, copy]
    }),
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
// codex-acp doesn't accept --model; it takes config overrides via `-c key=value` (TOML).
const MODEL_ARGS_PER_PRESET: Partial<Record<PresetName, ((model: string) => string[]) | null>> = {
  claude: (m) => ['--model', m],
  codex: (m) => ['-c', `model="${m.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`],
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
    const builder = MODEL_ARGS_PER_PRESET[name]
    if (builder) args.push(...builder(opts.model))
  }
  return { command: entry.command, args }
}
