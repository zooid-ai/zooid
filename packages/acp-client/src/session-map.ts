export interface SessionKey {
  threadId: string
  agentId: string
}

export interface SessionRecord {
  sessionId: string
  startedAt: number
}

const keyOf = (k: SessionKey) => `${k.threadId}\x00${k.agentId}`

interface InternalRecord extends SessionRecord {
  agentId: string
}

export class SessionMap {
  private readonly inner = new Map<string, InternalRecord>()

  get(k: SessionKey): SessionRecord | undefined {
    const v = this.inner.get(keyOf(k))
    if (!v) return undefined
    return { sessionId: v.sessionId, startedAt: v.startedAt }
  }

  set(k: SessionKey, value: SessionRecord): void {
    this.inner.set(keyOf(k), {
      sessionId: value.sessionId,
      startedAt: value.startedAt,
      agentId: k.agentId,
    })
  }

  delete(k: SessionKey): void {
    this.inner.delete(keyOf(k))
  }

  listForAgent(agentId: string): SessionRecord[] {
    const out: SessionRecord[] = []
    for (const v of this.inner.values()) {
      if (v.agentId === agentId) {
        out.push({ sessionId: v.sessionId, startedAt: v.startedAt })
      }
    }
    return out
  }
}
