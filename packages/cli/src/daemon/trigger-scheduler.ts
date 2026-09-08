import { Cron } from 'croner'
import type { TriggerConfig } from '@zooid/core'
import { fireTrigger, type FireTriggerDeps } from './trigger-runner.js'

export interface StartTriggerSchedulerDeps {
  triggers: Record<string, TriggerConfig>
  agentUserIds: Record<string, string>
  resolveRoom: FireTriggerDeps['resolveRoom']
  ensureBot: FireTriggerDeps['ensureBot']
  sendMessage: FireTriggerDeps['sendMessage']
}

export interface TriggerSchedulerHandle {
  stop(): Promise<void>
}

/**
 * Cron-expression validator backed by croner's own parser, injected into
 * `loadZooidConfig({ validateCron })` so a malformed `schedule:` fails at
 * config-load time with croner's real error, not a generic field-count check.
 * `core` stays cron-dependency-free; only the daemon entrypoint needs this.
 */
export function validateCron(name: string, expr: string): void {
  try {
    new Cron(expr, { paused: true }).stop()
  } catch (err) {
    throw new Error(`triggers.${name}.schedule: ${(err as Error).message}`)
  }
}

export function startTriggerScheduler(deps: StartTriggerSchedulerDeps): TriggerSchedulerHandle {
  const { triggers, agentUserIds, resolveRoom, ensureBot, sendMessage } = deps
  const jobs: Cron[] = []

  for (const [name, trigger] of Object.entries(triggers)) {
    if (!trigger.schedule) continue
    const agentUserId = agentUserIds[trigger.mention]
    if (!agentUserId) {
      console.warn(`[trigger:${name}] unknown agent "${trigger.mention}" — skipping`)
      continue
    }
    const job = new Cron(trigger.schedule, () => {
      void fireTrigger({ name, trigger, agentUserId, resolveRoom, ensureBot, sendMessage })
    })
    jobs.push(job)
  }

  return {
    async stop(): Promise<void> {
      for (const job of jobs) job.stop()
    },
  }
}
