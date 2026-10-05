/**
 * [[ZOD091]] Typing is a claim about a room, not a turn. One indicator per
 * (room, agent), raised on the first working turn and lowered on the last.
 * `live` = turns in flight; `working` = those not parked on a human. The
 * indicator is `working.size > 0`; `live` guards a late resume.
 */
export const TYPING_TTL_MS = 30_000
export const TYPING_REFRESH_MS = 25_000

export interface TypingAgent {
  name: string
  userId: string
}

export interface TypingWire {
  setTyping(input: { roomId: string; asUserId: string; typing: boolean; timeoutMs?: number }): Promise<void>
  setPresence(input: { asUserId: string; presence: 'online' | 'unavailable' }): Promise<void>
}

export interface TypingRegistryOptions {
  wire: TypingWire
  ttlMs?: number
  refreshMs?: number
  warn?: (msg: string, err?: unknown) => void
}

export interface TypingRegistry {
  /** A turn starts. */
  enter(roomId: string, agent: TypingAgent, sessionId: string): Promise<void>
  /** A turn reached a terminal outcome. Idempotent. */
  exit(roomId: string, agent: TypingAgent, sessionId: string): Promise<void>
  /** The turn is waiting on a human. */
  pause(roomId: string, agent: TypingAgent, sessionId: string): Promise<void>
  /** The wait ended. No-op unless the turn is still live. */
  resume(roomId: string, agent: TypingAgent, sessionId: string): Promise<void>
  isTyping(roomId: string, userId: string): boolean
}

interface Slot {
  roomId: string
  agent: TypingAgent
  live: Set<string>
  working: Set<string>
  refresh?: ReturnType<typeof setInterval>
}

export function createTypingRegistry(opts: TypingRegistryOptions): TypingRegistry {
  const ttlMs = opts.ttlMs ?? TYPING_TTL_MS
  const refreshMs = opts.refreshMs ?? TYPING_REFRESH_MS
  const warn = opts.warn ?? ((msg: string, err?: unknown) => console.warn(msg, err))
  const slots = new Map<string, Slot>()
  // Per slot key and per presence key: wire calls in order, never overlapping.
  const tails = new Map<string, Promise<void>>()
  // userId → rooms where that agent has a working turn.
  const workingRooms = new Map<string, number>()

  const slotKey = (roomId: string, userId: string) => `${roomId}\u0000${userId}`
  const presenceKey = (userId: string) => `presence\u0000${userId}`

  function queue(key: string, label: string, call: () => Promise<void>): Promise<void> {
    const next = (tails.get(key) ?? Promise.resolve()).then(call).catch((err) => warn(`[matrix] ${label} failed:`, err))
    tails.set(key, next)
    void next.then(() => {
      if (tails.get(key) === next) tails.delete(key)
    })
    return next
  }

  function settled(slot: Slot): Promise<void> {
    return Promise.all([
      tails.get(slotKey(slot.roomId, slot.agent.userId)),
      tails.get(presenceKey(slot.agent.userId)),
    ]).then(() => {})
  }

  function sendTyping(slot: Slot, typing: boolean): void {
    const { roomId, agent } = slot
    void queue(slotKey(roomId, agent.userId), `[${agent.name}] setTyping(${typing})`, () =>
      opts.wire.setTyping(
        typing ? { roomId, asUserId: agent.userId, typing, timeoutMs: ttlMs } : { roomId, asUserId: agent.userId, typing },
      ),
    )
  }

  function sendPresence(agent: TypingAgent, presence: 'online' | 'unavailable'): void {
    void queue(presenceKey(agent.userId), `[${agent.name}] setPresence(${presence})`, () =>
      opts.wire.setPresence({ asUserId: agent.userId, presence }),
    )
  }

  function raise(slot: Slot): void {
    sendTyping(slot, true)
    // Checks the set on each tick rather than trusting its own existence.
    slot.refresh = setInterval(() => {
      if (slot.working.size > 0) sendTyping(slot, true)
    }, refreshMs)
    const n = (workingRooms.get(slot.agent.userId) ?? 0) + 1
    workingRooms.set(slot.agent.userId, n)
    if (n === 1) sendPresence(slot.agent, 'unavailable')
  }

  function lower(slot: Slot): void {
    // Clear before lower: no refresh may be queued after the false.
    clearInterval(slot.refresh)
    slot.refresh = undefined
    sendTyping(slot, false)
    const n = (workingRooms.get(slot.agent.userId) ?? 1) - 1
    if (n > 0) workingRooms.set(slot.agent.userId, n)
    else {
      workingRooms.delete(slot.agent.userId)
      sendPresence(slot.agent, 'online')
    }
  }

  function markWorking(slot: Slot, sessionId: string): void {
    if (slot.working.has(sessionId)) return
    slot.working.add(sessionId)
    if (slot.working.size === 1) raise(slot)
  }

  function unmarkWorking(slot: Slot, sessionId: string): void {
    if (!slot.working.delete(sessionId)) return
    if (slot.working.size === 0) lower(slot)
  }

  return {
    enter(roomId, agent, sessionId) {
      const key = slotKey(roomId, agent.userId)
      let slot = slots.get(key)
      if (!slot) {
        slot = { roomId, agent, live: new Set(), working: new Set() }
        slots.set(key, slot)
      }
      slot.live.add(sessionId)
      markWorking(slot, sessionId)
      return settled(slot)
    },
    exit(roomId, agent, sessionId) {
      const key = slotKey(roomId, agent.userId)
      const slot = slots.get(key)
      if (!slot || !slot.live.has(sessionId)) {
        warn(`[matrix:${agent.name}] typing exit for a session not in flight (${sessionId}); ignored`)
        return slot ? settled(slot) : Promise.resolve()
      }
      slot.live.delete(sessionId)
      unmarkWorking(slot, sessionId)
      const done = settled(slot)
      if (slot.live.size === 0) slots.delete(key)
      return done
    },
    pause(roomId, agent, sessionId) {
      const slot = slots.get(slotKey(roomId, agent.userId))
      if (!slot) return Promise.resolve()
      unmarkWorking(slot, sessionId)
      return settled(slot)
    },
    resume(roomId, agent, sessionId) {
      const slot = slots.get(slotKey(roomId, agent.userId))
      if (!slot || !slot.live.has(sessionId)) return Promise.resolve()
      markWorking(slot, sessionId)
      return settled(slot)
    },
    isTyping(roomId, userId) {
      return (slots.get(slotKey(roomId, userId))?.working.size ?? 0) > 0
    },
  }
}
