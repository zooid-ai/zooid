import { randomUUID } from 'node:crypto'
import type { SpawnBinding } from './types.js'
import type { TaskActions, TransportContextProvider, ThreadRef } from '@zooid/core'

export class SpawnRegistry {
  private readonly bindings = new Map<string, SpawnBinding>()
  private readonly spawnByAgentSession = new Map<string, string>()
  private readonly spawnByAcpSession = new Map<string, string>()
  private tasks: TaskActions | undefined

  register(input: {
    agentName: string
    threadRef: ThreadRef
    provider: TransportContextProvider
    sessionKey?: string
  }): string {
    const spawnId = randomUUID()
    this.bindings.set(spawnId, { spawnId, ...input })
    this.spawnByAgentSession.set(this.key(input.agentName, input.sessionKey ?? input.threadRef.threadId), spawnId)
    return spawnId
  }

  get(spawnId: string): SpawnBinding | undefined {
    return this.bindings.get(spawnId)
  }

  release(spawnId: string): void {
    this.bindings.delete(spawnId)
    for (const [key, value] of this.spawnByAgentSession) {
      if (value === spawnId) this.spawnByAgentSession.delete(key)
    }
    for (const [key, value] of this.spawnByAcpSession) {
      if (value === spawnId) this.spawnByAcpSession.delete(key)
    }
  }
  linkSession(agentName: string, sessionKey: string, acpSessionId: string): void {
    const spawnId = this.spawnByAgentSession.get(this.key(agentName, sessionKey))
    if (spawnId) this.spawnByAcpSession.set(acpSessionId, spawnId)
  }
  getByAcpSession(acpSessionId: string): SpawnBinding | undefined {
    const spawnId = this.spawnByAcpSession.get(acpSessionId)
    return spawnId ? this.bindings.get(spawnId) : undefined
  }
  setTaskActions(actions: TaskActions | undefined): void {
    this.tasks = actions
  }
  get taskActions(): TaskActions | undefined {
    return this.tasks
  }
  private key(agentName: string, sessionKey: string): string {
    return `${agentName}::${sessionKey}`
  }
}
