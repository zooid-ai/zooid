import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DeliveryCache } from './delivery-cache.js'

describe('DeliveryCache', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('accepts an id once and rejects the replay', () => {
    const c = new DeliveryCache(60_000)
    expect(c.seen('abc')).toBe(false)
    expect(c.seen('abc')).toBe(true)
  })

  it('treats ids from different triggers as distinct', () => {
    const c = new DeliveryCache(60_000)
    expect(c.seen('t1:abc')).toBe(false)
    expect(c.seen('t2:abc')).toBe(false)
  })

  it('forgets an id after the TTL, so the cache cannot grow without bound', () => {
    const c = new DeliveryCache(60_000)
    c.seen('abc')
    vi.advanceTimersByTime(61_000)
    expect(c.seen('abc')).toBe(false)
  })

  it('evicts expired entries rather than retaining them forever', () => {
    const c = new DeliveryCache(1_000)
    for (let i = 0; i < 1000; i++) c.seen(`id-${i}`)
    vi.advanceTimersByTime(2_000)
    c.seen('trigger-eviction')
    expect(c.size).toBeLessThan(10)
  })
})
