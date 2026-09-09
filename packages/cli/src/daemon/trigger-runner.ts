import type { TriggerMessage } from '@zooid/core'

export interface FireTriggerDeps {
  name: string
  as: string
  message: TriggerMessage
  agentUserId: string
  resolveRoom: (room: string) => Promise<string | null>
  ensureBot: (asUserId: string, roomId: string) => Promise<void>
  sendMessage: (input: {
    roomId: string
    asUserId: string
    content: { msgtype: string; body: string; [k: string]: unknown }
  }) => Promise<{ event_id: string }>
}

export async function fireTrigger(deps: FireTriggerDeps): Promise<void> {
  const { name, as, message, agentUserId, resolveRoom, ensureBot, sendMessage } = deps
  try {
    const roomId = await resolveRoom(message.room)
    if (!roomId) {
      console.warn(`[trigger:${name}] cannot resolve room ${message.room} — skipping`)
      return
    }
    await ensureBot(as, roomId)
    await sendMessage({
      roomId,
      asUserId: as,
      content: {
        msgtype: 'm.text',
        body: message.text,
        // Structural mention: routes deterministically AND disarms the raw-body
        // fallback in extractMentions, which only fires when nothing matched.
        'm.mentions': { user_ids: [agentUserId] },
      },
    })
  } catch (err) {
    // Never throw: one bad firing must not take down the scheduler.
    console.warn(`[trigger:${name}] failed:`, (err as Error).message)
  }
}
