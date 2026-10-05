import type { AgentConfig } from '@zooid/core'

type HookCarrier = Pick<AgentConfig, 'hooks'>

/**
 * Build the startup warning for `hooks:` that the daemon parses but never runs,
 * or null when no agent has a hook set. Keys are read from the resolved
 * `AgentConfig.hooks`, so workforce-wide defaults count and a per-agent
 * null-disable (which deletes the key) does not.
 */
export function ignoredHooksWarning(agents: Record<string, HookCarrier>): string | null {
  const lines: string[] = []
  for (const [name, agent] of Object.entries(agents)) {
    const keys = Object.entries(agent.hooks)
      .filter(([, cmd]) => typeof cmd === 'string')
      .map(([key]) => key)
    if (keys.length > 0) lines.push(`  ${name}: ${keys.join(', ')}`)
  }
  if (lines.length === 0) return null
  return [
    '[hooks] hooks are configured but the daemon does not execute them:',
    ...lines,
    '[hooks] Use the agent\'s own hook mechanism instead (Claude Code settings.json hooks, opencode plugins).',
  ].join('\n')
}
