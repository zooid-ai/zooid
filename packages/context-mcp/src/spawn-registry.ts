import { randomUUID } from 'node:crypto'
import type { SpawnBinding } from './types.js'
import type { TransportContextProvider, ThreadRef } from '@zooid/core'

export class SpawnRegistry {
  private readonly bindings = new Map<string, SpawnBinding>()

  register(input: {
    agentName: string
    threadRef: ThreadRef
    provider: TransportContextProvider
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
}
