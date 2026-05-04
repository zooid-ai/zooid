import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { AgentAdapter, SpawnConfig } from '@zooid/core'
import {
  findCodexSessionFile,
  isCodexSessionBusy,
  tailCodexSessionFile,
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
 * Adapter for OpenAI Codex CLI (`codex`). Uses `codex exec --json` for
 * non-interactive execution. New sessions let Codex pick its own id
 * (UUID v7); resumes use `codex exec resume --json <id>`.
 *
 * Strategy: `deferred`. Codex mints its own session id and surfaces it
 * as a `thread.started` JSONL event on the first stdout line. The runner
 * watches via `parseOutput()` and emits `session.start` when it arrives.
 */
export const codexAdapter: AgentAdapter = {
  name: 'codex',
  envPassthrough: ['CODEX_API_KEY'],
  workspaceReadOnly: ['AGENTS.md', '.codex'],
  homeReadOnly: ['.codex/config.toml'],
  sessionStateDir() {
    // Codex buckets its session JSONLs by date under .codex/sessions; the
    // partitioning is internal to the CLI, so we just mount the top-level dir.
    return '.codex/sessions'
  },
  isAvailable(pathOverride) {
    const p = pathOverride ?? process.env.PATH ?? ''
    return findOnPath('codex', p) !== null
  },
  prepareNewSession() {
    return { strategy: 'deferred' }
  },
  spawn({ prompt, session_id, resume }): SpawnConfig {
    const baseArgs = ['exec']

    if (resume) {
      // codex exec resume --json [--skip-git-repo-check] <SESSION_ID> "<prompt>"
      // Note: --sandbox is NOT accepted on resume.
      baseArgs.push(
        'resume',
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
      )
      if (!session_id) {
        throw new Error('codexAdapter.spawn: session_id is required for resume')
      }
      baseArgs.push(session_id, prompt)
    } else {
      // codex exec --json [--skip-git-repo-check] [--sandbox <mode>] "<prompt>"
      baseArgs.push(
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
      )
      baseArgs.push(prompt)
    }

    return { command: 'codex', args: baseArgs }
  },
  parseOutput(line) {
    let parsed: { type?: string; thread_id?: string; item?: unknown }
    try {
      parsed = JSON.parse(line)
    } catch {
      return { kind: 'ignore' }
    }
    if (
      parsed.type === 'thread.started' &&
      typeof parsed.thread_id === 'string'
    ) {
      return { kind: 'session_started', session_id: parsed.thread_id }
    }
    if (parsed.type === 'item.completed') {
      return { kind: 'message', raw: parsed }
    }
    return { kind: 'ignore' }
  },
  /**
   * Tail Codex's persistent session file as a stream of SessionEvents.
   * Returns null if no file exists for that id (the route surfaces this as 404).
   */
  async openStream(id, _cwd) {
    const filePath = await findCodexSessionFile(id)
    if (!filePath) return null
    return tailCodexSessionFile(filePath)
  },
  /**
   * Inspect the JSONL session file to decide whether the session is currently
   * mid-turn. Used by the HTTP transport to 409 a `POST /sessions/:id/turns`
   * that races an in-flight turn.
   */
  async isSessionBusy(id, _cwd) {
    const filePath = await findCodexSessionFile(id)
    if (!filePath) return false
    return isCodexSessionBusy(filePath)
  },
}
