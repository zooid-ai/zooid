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
  /**
   * How a `runtime: vm` agent on this preset reaches its model without the
   * credential entering the guest: a host proxy injects it. [ZOD128]
   */
  vmCredential?: PresetVmCredential
}

/**
 * The host-side credential proxy contract for one preset. The guest calls
 * `127.0.0.1:<guestPort>`, a guest forwarder carries that to `guestSocket`
 * (a mounted host Unix socket), and the host proxy swaps the placeholder
 * credential for the real one before calling `upstream`. [ZOD128]
 */
export interface PresetVmCredential {
  provider: 'openai-codex'
  /** Origin the proxy forwards to. */
  upstream: string
  /** Path prefixes the proxy forwards; everything else is refused. */
  allowPaths: string[]
  /** Host dir holding the dedicated login (`auth.json`) the proxy alone refreshes. */
  authDir: (ctx: { daemonHome: string }) => string
  guestSocket: string
  guestPort: number
  /** Env for the guest ACP process. */
  guestEnv: Record<string, string>
  /** Idempotent, credential-free sh run as root in the guest after every start. */
  guestSetup: string
}

const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')

/**
 * What a vm guest's pi holds instead of a key. pi refuses a key without the
 * account claim, so the placeholder carries a fake one; the proxy replaces
 * both the bearer and the `chatgpt-account-id` header. [ZOD128]
 */
export const VM_PLACEHOLDER_CODEX_KEY = [
  b64url({ alg: 'none', typ: 'JWT' }),
  b64url({ 'https://api.openai.com/auth': { chatgpt_account_id: 'zooid-placeholder' } }),
  'sig',
].join('.')

const PI_GUEST_AGENT_DIR = '/root/.pi/agent'
const PI_GUEST_PORT = 8787

// Run with models.json and settings.json paths as argv[1] and argv[2]. JSON literals are generated here, so the
// script holds no single quotes and sits safely inside sh's '…'.
const PI_GUEST_CONFIG_JS = [
  'const fs=require("fs");const [models,f]=process.argv.slice(1);',
  `fs.writeFileSync(models,JSON.stringify(${JSON.stringify({
    providers: {
      'openai-codex': {
        baseUrl: `http://127.0.0.1:${PI_GUEST_PORT}/backend-api`,
        apiKey: VM_PLACEHOLDER_CODEX_KEY,
      },
    },
  })},null,2)+"\\n");`,
  'let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}',
  // websocket is pi-codex's default; sse keeps the proxy plain HTTP.
  's["transport"]="sse";fs.writeFileSync(f,JSON.stringify(s,null,2)+"\\n");',
].join('')

// The workdir mount is read-only and pi writes sessions into its agent dir,
// so the workdir's `.pi-agent` is copied (minus sessions) into a writable
// one. Staged, so the guest's own sessions are never touched. Paths take a
// ZOOID_GUEST_ROOT prefix (unset in the guest) so tests can run it.
const PI_GUEST_SETUP = `set -e
R="\${ZOOID_GUEST_ROOT:-}"
A="$R${PI_GUEST_AGENT_DIR}"
mkdir -p "$A"
if [ -d "$R/workspace/.pi-agent" ]; then
  S="$(mktemp -d)"
  cp -R "$R/workspace/.pi-agent/." "$S/"
  rm -rf "$S/sessions"
  cp -R "$S/." "$A/"
  rm -rf "$S"
fi
node -e '${PI_GUEST_CONFIG_JS}' "$R${PI_GUEST_AGENT_DIR}/models.json" "$R${PI_GUEST_AGENT_DIR}/settings.json"
`

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
  // pi (ZOD073). Vendored-shim category: `pi-acp` is an adapter that speaks ACP
  // on pi's behalf and spawns `pi --mode rpc` as a child. No flags — its
  // published Zed config is `args: []`, and the only documented flag
  // (--terminal-login) is an interactive auth path with no place in a daemon.
  pi: {
    command: 'npx',
    args: ['-y', 'pi-acp'],
    image: 'ghcr.io/zooid-ai/agent-pi:latest',
    mounts: (ctx: PresetMountContext): PresetMount[] => [
      {
        // Single tree: agent/sessions, agent/prompts, and the adapter's
        // pi-acp/session-map.json. Project config lives in <cwd>/.pi, which is
        // already inside the workspace mount.
        id: 'home',
        host: `${ctx.daemonHome}/.pi`,
        target: '/root/.pi',
        mode: 'rw',
        create: false,
      },
    ],
    vmCredential: {
      provider: 'openai-codex',
      upstream: 'https://chatgpt.com',
      allowPaths: ['/backend-api/codex/'],
      // A dedicated device-code login: refresh tokens rotate, so the proxy
      // must be its only refresher (sharing ~/.pi/agent kills other logins).
      authDir: ({ daemonHome }: { daemonHome: string }) => `${daemonHome}/.zooid/cred-proxy/pi`,
      guestSocket: '/run/zooid/model.sock',
      guestPort: PI_GUEST_PORT,
      guestEnv: { PI_CODING_AGENT_DIR: PI_GUEST_AGENT_DIR },
      guestSetup: PI_GUEST_SETUP,
    },
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
      if ('vmCredential' in e) {
        const c = e.vmCredential as PresetVmCredential
        copy.vmCredential = { ...c, allowPaths: [...c.allowPaths], guestEnv: { ...c.guestEnv } }
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
