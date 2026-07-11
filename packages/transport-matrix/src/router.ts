import type { RoomBinding } from '@zooid/core'
import { extractMentions } from './mentions.js'

export type { RoomBinding }

export interface AgentBinding {
  name: string
  userId: string
  /** Optional human-readable display name. Falls back to the user_id localpart. */
  displayName?: string
  /**
   * Rooms this agent is bound to. Each entry's `alias` starts out as the
   * configured `#alias` (or `!id`) and is rewritten to the canonical room
   * ID by `BotPool.bootstrap`. Optional `powerLevel` is seeded into the
   * room's `m.room.power_levels.users` at room creation only.
   */
  rooms: RoomBinding[]
  trigger: 'mention' | 'any'
  /** Host path of the agent's workspace (resolved agent.workdir). Media files land here. */
  workspaceDir?: string
  /** Path prefix as the agent sees it: '/workspace' for containers, = workspaceDir for local. */
  agentWorkspacePath?: string
}

export const MEDIA_MSGTYPES = new Set(['m.image', 'm.file', 'm.video', 'm.audio'])

export function isMediaMsgtype(t: string | undefined): boolean {
  return t !== undefined && MEDIA_MSGTYPES.has(t)
}

export interface ThreadState {
  /** Agent names that have posted in this thread, in order. */
  participants: string[]
  /** Agent names @mentioned in the thread root event (or subsequently). */
  rootMentions: string[]
  /**
   * Agent-to-agent call edges: sub-agent name → the agent that @mentioned
   * (called) it in this thread. A sub's bare reply bubbles up to its caller;
   * a caller never implicitly re-triggers its callee. Makes agent↔agent
   * acknowledgement loops structurally impossible. See [[ZOD039]] §
   * Implicit triggers → Directional continuation.
   */
  callers: Record<string, string>
}

interface MaybeEvent {
  type?: string
  room_id?: string
  sender?: string
  content?: {
    msgtype?: string
    'm.relates_to'?: { rel_type?: string; event_id?: string }
  }
}

export type RouteMatch = AgentBinding

function inboundThreadRoot(event: MaybeEvent): string | undefined {
  const r = event.content?.['m.relates_to']
  return r?.rel_type === 'm.thread' && r.event_id ? r.event_id : undefined
}

export function route(
  event: MaybeEvent,
  agents: AgentBinding[],
  threadStates?: Map<string, ThreadState>,
): RouteMatch[] {
  if (event.type !== 'm.room.message') return []
  if (!event.content?.msgtype) return []
  if (isMediaMsgtype(event.content.msgtype)) return []
  const mentions = new Set(extractMentions(event as never))
  const matches: RouteMatch[] = []
  const threadRoot = inboundThreadRoot(event)
  const threadState = threadRoot ? threadStates?.get(threadRoot) : undefined

  for (const a of agents) {
    if (event.sender === a.userId) continue
    if (!a.rooms.some((r) => r.alias === event.room_id)) continue
    if (a.trigger === 'any') {
      matches.push(a)
      continue
    }
    // trigger === 'mention'
    if (mentions.has(a.userId)) {
      matches.push(a)
      continue
    }
    // Implicit trigger in a thread.
    if (threadState) {
      const senderAgent = agents.find((x) => x.userId === event.sender)
      if (senderAgent) {
        // Agent reply = a "return": route only to the agent that called the
        // sender (its caller), never to a callee. Directional continuation
        // keeps agent↔agent handoffs from looping — the call graph is a tree
        // rooted at the human, so returns only ever walk up.
        if (threadState.callers[senderAgent.name] === a.name) matches.push(a)
      } else {
        // Human (or non-agent) follow-up: continue with the most-recent-posting
        // agent, or inherit the root mention if no agent has posted yet.
        const lastPoster = threadState.participants.at(-1)
        if (lastPoster) {
          if (lastPoster === a.name) matches.push(a)
        } else if (threadState.rootMentions.includes(a.name)) {
          matches.push(a)
        }
      }
    }
  }
  return matches
}
