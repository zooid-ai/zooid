import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { AgentAdapter, SpawnConfig } from '@zooid/agentd-core'

function findOnPath(binary: string, pathString: string): string | null {
  for (const dir of pathString.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, binary)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Adapter for Anthropic Claude Code (`claude` CLI). Uses non-interactive
 * `-p` mode with `stream-json` output. New sessions get an explicit
 * `--session-id`; resumes get `--resume <id>`.
 */
export const claudeAdapter: AgentAdapter = {
  name: 'claude',
  isAvailable(pathOverride) {
    const p = pathOverride ?? process.env.PATH ?? ''
    return findOnPath('claude', p) !== null
  },
  spawn({ prompt, session_id, resume }): SpawnConfig {
    const idFlag = resume ? '--resume' : '--session-id'
    return {
      command: 'claude',
      args: [
        '-p',
        prompt,
        idFlag,
        session_id,
        '--output-format',
        'stream-json',
      ],
    }
  },
  parseOutput(line) {
    try {
      const parsed = JSON.parse(line)
      return { kind: parsed.type ?? 'unknown', content: parsed }
    } catch {
      return { kind: 'raw', content: line }
    }
  },
}
