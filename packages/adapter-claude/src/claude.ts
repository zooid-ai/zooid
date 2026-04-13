import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { AgentAdapter, HomeMount, SpawnConfig } from '@zooid/budd-core'
import {
  claudeSessionFilePath,
  isClaudeSessionBusy,
  tailClaudeSessionFile,
} from './session-file.js'

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
 * `--session-id` (UUID); resumes get `--resume <id>`.
 *
 * Strategy: `preassigned`. Claude Code's `--session-id` requires a UUID,
 * so the adapter mints one with `crypto.randomUUID()` before the spawn.
 */
export const claudeAdapter: AgentAdapter = {
  name: 'claude',
  homeMounts: [
    { path: '.claude/settings.json', mode: 'ro' },
    { path: '.claude/projects', mode: 'rw' },
    { path: '.claude/memory', mode: 'rw' },
  ] satisfies HomeMount[],
  isAvailable(pathOverride) {
    const p = pathOverride ?? process.env.PATH ?? ''
    return findOnPath('claude', p) !== null
  },
  prepareNewSession() {
    return { strategy: 'preassigned', session_id: randomUUID() }
  },
  spawn({ prompt, session_id, resume }): SpawnConfig {
    // For claude, session_id is always defined: preassigned strategy on
    // new turns, caller-supplied on resume.
    if (!session_id) {
      throw new Error('claudeAdapter.spawn: session_id is required')
    }
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
        // stream-json requires --verbose when combined with -p (Claude Code
        // refuses to start otherwise: "Error: When using --print,
        // --output-format=stream-json requires --verbose").
        '--verbose',
      ],
    }
  },
  /**
   * Tail Claude Code's persistent session file as a stream of SessionEvents.
   * Returns null if the file doesn't exist (the route surfaces this as 404).
   * See `session-file.ts` for the on-disk layout and tailer semantics.
   */
  openStream(id, cwd) {
    const filePath = claudeSessionFilePath(id, cwd)
    return tailClaudeSessionFile(filePath)
  },
  /**
   * Inspect the JSONL session file to decide whether the session is currently
   * mid-turn. See `isClaudeSessionBusy` for the detection rules and the known
   * SIGKILL gap. Used by the HTTP transport to 409 a `POST /sessions/:id/turns`
   * that races an in-flight turn.
   */
  isSessionBusy(id, cwd) {
    const filePath = claudeSessionFilePath(id, cwd)
    return isClaudeSessionBusy(filePath)
  },
}
