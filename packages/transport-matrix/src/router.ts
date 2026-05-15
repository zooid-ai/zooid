import { extractMentions } from './mentions.js'

export interface AgentBinding {
  name: string
  userId: string
  /** Optional human-readable display name. Falls back to the user_id localpart. */
  displayName?: string
  rooms: string[]
  trigger: 'mention' | 'any'
}

export interface ThreadState {
  /** Agent names that have posted in this thread, in order. */
  participants: string[]
  /** Agent names @mentioned in the thread root event (or subsequently). */
  rootMentions: string[]
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
  const mentions = new Set(extractMentions(event as never))
  const matches: RouteMatch[] = []
  const threadRoot = inboundThreadRoot(event)
  const threadState = threadRoot ? threadStates?.get(threadRoot) : undefined

  for (const a of agents) {
    if (event.sender === a.userId) continue
    if (!a.rooms.includes(event.room_id ?? '')) continue
    if (a.trigger === 'any') {
      matches.push(a)
      continue
    }
    // trigger === 'mention'
    if (mentions.has(a.userId)) {
      matches.push(a)
      continue
    }
    // Implicit trigger in a thread: most-recent-poster, or root-mention
    // inheritance if no agent has posted yet.
    if (threadState) {
      const lastPoster = threadState.participants.at(-1)
      if (lastPoster) {
        if (lastPoster === a.name) matches.push(a)
      } else if (threadState.rootMentions.includes(a.name)) {
        matches.push(a)
      }
    }
  }
  return matches
}
