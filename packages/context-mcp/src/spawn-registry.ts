import { randomUUID } from 'node:crypto'
import type { SpawnBinding } from './types.js'
import type { TaskActions, TransportContextProvider, ThreadRef } from '@zooid/core'

export class SpawnRegistry {
  private readonly bindings = new Map<string, SpawnBinding>()
  private tasks: TaskActions | undefined

  register(input: {
    agentName: string
    threadRef: ThreadRef
    provider: TransportContextProvider
    sessionKey?: string
  }): string {
    const spawnId = randomUUID()
    this.bindings.set(spawnId, { spawnId, ...input })
    return spawnId
  }

  get(spawnId: string): SpawnBinding | undefined {
    return this.bindings.get(spawnId)
  }

  release(spawnId: string): void {
    this.bindings.delete(spawnId)
  }
  setTaskActions(actions: TaskActions | undefined): void {
    this.tasks = actions
  }
  get taskActions(): TaskActions | undefined {
    return this.tasks
  }
}
