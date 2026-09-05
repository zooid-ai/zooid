import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  generateAgentsMd,
  generateClaudeMd,
  generateClaudeSettings,
  generateEnv,
  generateGitignore,
  generateOpencodeJson,
  generateOpencodeReadme,
  generatePiSettings,
  generateZooidYaml,
} from './init/generators.js'
import {
  findOpencodeProvider,
  findPiProvider,
  findSimplePreset,
  PI_AGENT_DIR,
  PI_AUTH_FILE,
  PI_DEFAULT_MODEL,
  PI_DEFAULT_PROVIDER,
} from './init/registry.js'
import { sniffCredentials, sniffPiDefaults } from './init/sniff.js'

export interface InitOptions {
  dir: string
  preset: 'claude' | 'codex' | 'opencode' | 'pi'
  /** Required for claude/codex/pi; ignored for opencode. */
  auth?: 'subscription' | 'api-key'
  /** Optional model pin. Omitted by default — the harness uses its own default. */
  model?: string
  /** opencode/pi provider id; defaults to `opencode-go` for opencode. */
  provider?: string
  /** Required on api-key path; required for opencode. */
  apiKey?: string
  /** Allow generating into a non-empty dir. */
  force?: boolean
  /** Required with `force` to overwrite existing files. */
  overwrite?: boolean
  /** Overridable for tests; defaults to os.homedir(). */
  home?: string
}

interface WriteSpec {
  path: string
  content: string
}

// Pre-existing entries that don't count toward "non-empty". Lets operators
// run `pnpm install` before `zooid init` without tripping the guard.
const IGNORED_PREEXISTING = new Set([
  '.',
  '..',
  '.git',
  '.DS_Store',
  'node_modules',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
])

export async function runInit(opts: InitOptions): Promise<void> {
  const dir = resolve(opts.dir)
  mkdirSync(dir, { recursive: true })

  if (!opts.force) {
    const blocking = readdirSync(dir).filter((n) => !IGNORED_PREEXISTING.has(n))
    if (blocking.length > 0) {
      throw new Error(
        `${dir} is non-empty (use --force to allow scaffolding into it). Conflicting entries: ${blocking.join(', ')}`,
      )
    }
  }

  const writes: WriteSpec[] = []
  let piInherited: { provider: string; model: string; source: string } | undefined

  if (opts.preset === 'claude' || opts.preset === 'codex') {
    if (!opts.auth) throw new Error('--auth (subscription|api-key) is required for claude/codex')
    const meta = findSimplePreset(opts.preset)!

    writes.push({
      path: 'zooid.yaml',
      content: generateZooidYaml({ preset: opts.preset, model: opts.model }),
    })
    writes.push({ path: 'agents/zooid-assistant/AGENTS.md', content: generateAgentsMd() })

    if (opts.preset === 'claude') {
      writes.push({
        path: 'agents/zooid-assistant/CLAUDE.md',
        content: generateClaudeMd(),
      })
      writes.push({
        path: 'agents/zooid-assistant/.claude/settings.json',
        content: generateClaudeSettings(),
      })
    }

    if (opts.auth === 'api-key') {
      if (!opts.apiKey) throw new Error('--api-key is required when --auth=api-key')
      writes.push({
        path: '.env',
        content: generateEnv({ envVar: meta.apiKeyEnvVar, value: opts.apiKey }),
      })
    }
  } else if (opts.preset === 'opencode') {
    if (!opts.provider) throw new Error('--provider is required for opencode')
    const isCustom = opts.provider === 'custom'
    const providerMeta = isCustom ? undefined : findOpencodeProvider(opts.provider)
    if (!isCustom && !providerMeta) throw new Error(`unknown opencode provider: ${opts.provider}`)
    if (!isCustom && !opts.apiKey) throw new Error('--api-key is required for opencode')

    writes.push({ path: 'zooid.yaml', content: generateZooidYaml({ preset: 'opencode' }) })
    writes.push({ path: 'agents/zooid-assistant/AGENTS.md', content: generateAgentsMd() })
    writes.push({
      path: 'agents/zooid-assistant/opencode.json',
      content: generateOpencodeJson({
        provider: opts.provider,
        model: opts.model,
        apiKeyEnvVar: providerMeta?.apiKeyEnvVar,
      }),
    })
    if (isCustom) {
      writes.push({
        path: 'agents/zooid-assistant/opencode.json.README',
        content: generateOpencodeReadme(),
      })
    } else {
      writes.push({
        path: '.env',
        content: generateEnv({ envVar: providerMeta!.apiKeyEnvVar, value: opts.apiKey! }),
      })
    }
  } else if (opts.preset === 'pi') {
    // Same binary as claude/codex, because pi has the same two tiers. The
    // difference is that the api-key side also needs a provider.
    if (!opts.auth) throw new Error('--auth (subscription|api-key) is required for pi')
    if (opts.auth === 'subscription' && !sniffCredentials('pi', opts.home).found) {
      throw new Error(
        'no pi login found — run `pi` and /login first, or use --auth api-key',
      )
    }
    if (opts.auth === 'api-key' && !opts.provider) {
      throw new Error('--provider is required for pi --auth api-key')
    }
    const providerMeta = opts.provider ? findPiProvider(opts.provider) : undefined
    if (opts.provider && !providerMeta) throw new Error(`unknown pi provider: ${opts.provider}`)

    // Inherit before pinning: a pair the operator already runs interactively is
    // verified by use. Explicit flags still win over an inherited value.
    const inherited = sniffPiDefaults(opts.home)
    const provider = opts.provider ?? inherited?.provider ?? PI_DEFAULT_PROVIDER
    const model = opts.model ?? inherited?.model ?? PI_DEFAULT_MODEL
    const settingsProvider = opts.model ? provider : (inherited?.provider ?? provider)

    writes.push({ path: 'zooid.yaml', content: generateZooidYaml({ preset: 'pi' }) })
    writes.push({ path: 'agents/zooid-assistant/AGENTS.md', content: generateAgentsMd() })
    writes.push({
      path: `agents/zooid-assistant/${PI_AGENT_DIR}/settings.json`,
      content: generatePiSettings({ provider: settingsProvider, model }),
    })

    // PI_CODING_AGENT_DIR is relative on purpose: the agent's cwd is
    // agents/<name> locally and /workspace in a container, and those are the
    // same directory, so one value is correct under both runtimes (spike 1.1).
    const envLines = [`PI_CODING_AGENT_DIR=${PI_AGENT_DIR}`]
    // Only the api-key path writes a key. The subscription path shares the
    // operator's auth.json instead (below) and writes no credential here.
    if (opts.auth === 'api-key' && opts.apiKey) {
      envLines.push(`${providerMeta!.apiKeyEnvVar}=${opts.apiKey}`)
    }
    writes.push({ path: '.env', content: envLines.join('\n') + '\n' })

    piInherited = inherited
  } else {
    throw new Error(`unknown preset: ${String(opts.preset)}`)
  }

  writes.push({ path: '.gitignore', content: generateGitignore() })

  for (const w of writes) {
    const full = join(dir, w.path)
    const exists = existsSync(full)
    if (exists && !opts.overwrite) {
      console.warn(`⚠ ${w.path} exists; left as-is (use --force --overwrite to replace)`)
      continue
    }
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, w.content)
    console.log(`✓ Created ${w.path}`)
  }

  if ((opts.preset === 'claude' || opts.preset === 'codex') && opts.auth === 'subscription') {
    const s = sniffCredentials(opts.preset)
    if (s.found) {
      console.log(`✓ Found ${opts.preset} config at ${s.path}`)
    } else {
      console.warn(
        `⚠ No ${opts.preset} config detected — run \`${opts.preset}\` to log in before \`zooid dev\``,
      )
    }
  }

  if (opts.preset === 'pi') {
    if (piInherited) {
      console.log(
        `✓ Inherited defaultProvider=${piInherited.provider} defaultModel=${piInherited.model} from ${piInherited.source}`,
      )
    } else {
      console.log(
        `✓ Pinned defaultProvider=${PI_DEFAULT_PROVIDER} defaultModel=${PI_DEFAULT_MODEL} (pi's own default returns an empty turn)`,
      )
    }
    const s = sniffCredentials('pi', opts.home)
    if (opts.auth === 'subscription' && s.found) {
      // Symlink, not copy: pi rotates OAuth tokens via temp-file-and-rename
      // (spike 1.2), which a symlink survives because it names a path, not an
      // inode. Host-path only — this wizard only ever scaffolds `runtime:
      // local`, so the operator's real ~/.pi/agent/auth.json is the same file
      // the local agent process resolves against.
      const authSource = join(opts.home ?? homedir(), PI_AUTH_FILE)
      const linkPath = join(dir, `agents/zooid-assistant/${PI_AGENT_DIR}/auth.json`)
      if (!existsSync(linkPath)) {
        mkdirSync(dirname(linkPath), { recursive: true })
        symlinkSync(authSource, linkPath)
      }
      console.log(
        `✓ Shared pi login from ${s.path} — the agent uses your subscription via a symlink at ${PI_AGENT_DIR}/auth.json`,
      )
    } else if (s.found) {
      console.log(
        `✓ Found pi login at ${s.path} — the agent gets its own config at ${PI_AGENT_DIR}/ and will not touch it`,
      )
    } else {
      console.warn(`⚠ No pi login detected — the agent uses its own API key from .env`)
    }
  }

  console.log('\nNext: zooid dev')
}
