import { describe, expect, it } from 'vitest'
import { InvocationRegistry } from './invocation-registry.js'

describe('InvocationRegistry', () => {
  it('tracks a handoff before its Matrix event exists and resolves exactly once', () => {
    const registry = new InvocationRegistry({ newId: () => 'i1' })
    const invocation = registry.open({ taskId: 't1', callerAgent: 'a', callerSessionKey: '$root', calleeAgent: 'b' })
    expect(registry.outstandingFor('$root')).toHaveLength(1)
    registry.attachCallEvent(invocation.invocationId, '$call', '$root|$call')
    expect(registry.forCalleeSession('$root|$call')).toBe(invocation)
    expect(registry.resolve(invocation.invocationId)).toBe(invocation)
    expect(registry.resolve(invocation.invocationId)).toBeUndefined()
  })
  it('detects an outstanding ancestor and cancels late returns', () => {
    const registry = new InvocationRegistry({ newId: () => 'i1' })
    const invocation = registry.open({ taskId: 't1', callerAgent: 'a', callerSessionKey: '$root', calleeAgent: 'b' })
    registry.attachCallEvent('i1', '$call', '$root|$call')
    expect(registry.isOutstandingAncestor('$root|$call', 'a')).toBe(true)
    registry.cancelForTask('t1')
    expect(registry.resolve('i1')).toBeUndefined()
  })
})
