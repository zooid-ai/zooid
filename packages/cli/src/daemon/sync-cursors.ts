import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SyncCursorStore {
  loadSince(agentName: string): string | null
  saveSince(agentName: string, since: string): void
}

/**
 * File-backed `since` cursor store: `<agentsDir>/<agentName>/sync-since`, next
 * to the `(threadId → sessionId)` `sessions.json` buildAcpRegistry writes. Same
 * per-agent durable-state root, so an agent's restart-surviving state lives in
 * one folder. Agent names are validated kebab-case keys (ZOD063 isValidAgentKey),
 * so they're safe path segments — no hashing needed.
 */
export function makeSyncCursorStore(agentsDir: string): SyncCursorStore {
  const fileFor = (agentName: string): string => join(agentsDir, agentName, 'sync-since')
  return {
    loadSince(agentName) {
      try {
        return readFileSync(fileFor(agentName), 'utf8').trim() || null
      } catch {
        return null
      }
    },
    saveSince(agentName, since) {
      mkdirSync(join(agentsDir, agentName), { recursive: true })
      writeFileSync(fileFor(agentName), since, 'utf8')
    },
  }
}
