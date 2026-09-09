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
  /**
   * Handoff arcs per sub-agent: the event ids of the agent→agent @mention
   * messages that called it, in timeline order (last = current arc). Each
   * call opens a fresh ACP session keyed `threadRoot|callEventId`
   * ([[ZOD071]]). Append-only; rebuilt from the timeline after a restart.
   */
  handoffs: Record<string, string[]>
}

export interface TaskThreadContext {
  assignee: string
  isRoot: boolean
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
  task?: TaskThreadContext,
): RouteMatch[] {
  if (event.type !== 'm.room.message') return []
  if (!event.content?.msgtype) return []
  if (isMediaMsgtype(event.content.msgtype)) return []
  const mentions = new Set(extractMentions(event as never))
  const matches: RouteMatch[] = []
  const threadRoot = inboundThreadRoot(event)
  const threadState = threadRoot ? threadStates?.get(threadRoot) : undefined

  for (const a of agents) {
    if (!a.rooms.some((r) => r.alias === event.room_id)) continue
    if (task?.isRoot) {
      if (a.name === task.assignee) matches.push(a)
      continue
    }
    if (event.sender === a.userId) continue
    if (task) {
      if (mentions.has(a.userId)) {
        matches.push(a)
        continue
      }
      const senderAgent = agents.find((x) => x.userId === event.sender)
      if (senderAgent) {
        // A delegated task returns at an invocation terminal boundary, never
        // because a callee happened to post progress prose.
        continue
      } else if (a.name === task.assignee) {
        matches.push(a)
      }
      continue
    }
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
        if (isReturnRoute(event, a, agents, threadState)) matches.push(a)
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

/**
 * True when routing `event` to `agent` is a *return* — a callee's reply
 * bubbling up to the agent that called it — rather than a fresh call or a
 * human follow-up. A callee may address its existing caller explicitly and it
 * is still a return.
 *
 * The transport defers returns to the sender's turn boundary. An agent turn
 * posts one `m.room.message` per buffered chunk (every tool call forces a
 * flush), so treating each chunk as a return woke the caller once per chunk
 * and the two agents read as re-triggering each other. See [[ZOD039]]
 * § Implicit triggers → Directional continuation.
 */
export function isReturnRoute(
  event: MaybeEvent,
  agent: AgentBinding,
  agents: AgentBinding[],
  threadState: ThreadState | undefined,
): boolean {
  if (!threadState || agent.trigger !== 'mention') return false
  const sender = agents.find((x) => x.userId === event.sender)
  if (!sender || sender.name === agent.name) return false
  // Addressing the existing caller explicitly does not reverse the call edge:
  // it is still the callee returning control. This matters for agents that
  // naturally prefix their final answer with `@caller`; treating that as a new
  // call creates the exact A ↔ B cycle directional continuation prevents.
  return threadState.callers[sender.name] === agent.name
}

/**
 * True when recording `callee`’s caller as `caller` would put a cycle in the
 * call graph — i.e. `callee` is already an ancestor of `caller`. The graph has
 * to stay a tree rooted at the human, because `route` walks it upward on every
 * return; a 2-cycle (A calls B, B @mentions A back) would bounce forever.
 * A mention that would close a cycle is a return, not a call, so it routes but
 * records no edge.
 */
export function wouldCycleCallers(
  callers: Record<string, string>,
  callee: string,
  caller: string,
): boolean {
  const seen = new Set<string>()
  let cursor: string | undefined = caller
  while (cursor !== undefined) {
    if (cursor === callee || seen.has(cursor)) return true
    seen.add(cursor)
    cursor = callers[cursor]
  }
  return false
}
