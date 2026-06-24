import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  generateAgentsMd,
  generateClaudeMd,
  generateClaudeSettings,
  generateEnv,
  generateGitignore,
  generateOpencodeJson,
  generateOpencodeReadme,
  generateZooidYaml,
} from './init/generators.js'
import {
  findOpencodeProvider,
  findSimplePreset,
} from './init/registry.js'
import { sniffCredentials } from './init/sniff.js'

export interface InitOptions {
  dir: string
  preset: 'claude' | 'codex' | 'opencode'
  /** Required for claude/codex; ignored for opencode. */
  auth?: 'subscription' | 'api-key'
  /** Optional model pin. Omitted by default — the harness uses its own default. */
  model?: string
  /** opencode provider id; defaults to `opencode-go` in the wizard. */
  provider?: string
  /** Required on api-key path; required for opencode. */
  apiKey?: string
  /** Allow generating into a non-empty dir. */
  force?: boolean
  /** Required with `force` to overwrite existing files. */
  overwrite?: boolean
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

  console.log('\nNext: zooid dev')
}
