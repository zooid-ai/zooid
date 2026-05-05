import { extractMentions } from './mentions.js'

export interface AgentBinding {
  name: string
  userId: string
  rooms: string[]
  trigger: 'mention' | 'any'
}

interface MaybeEvent {
  type?: string
  room_id?: string
  sender?: string
  content?: { msgtype?: string }
}

export type RouteMatch = AgentBinding

export function route(event: MaybeEvent, agents: AgentBinding[]): RouteMatch[] {
  if (event.type !== 'm.room.message') return []
  if (!event.content?.msgtype) return []
  const mentions = new Set(extractMentions(event as never))
  const matches: RouteMatch[] = []
  for (const a of agents) {
    if (event.sender === a.userId) continue
    if (!a.rooms.includes(event.room_id ?? '')) continue
    if (a.trigger === 'mention' && !mentions.has(a.userId)) continue
    matches.push(a)
  }
  return matches
}
