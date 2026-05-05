import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { throttle } from './throttle.js'

describe('throttle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires the first call immediately', () => {
    const fn = vi.fn()
    const t = throttle(fn, 100)
    t('a')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('a')
  })

  it('drops calls inside the cooldown window', () => {
    const fn = vi.fn()
    const t = throttle(fn, 100)
    t('a')
    vi.advanceTimersByTime(20)
    t('b')
    vi.advanceTimersByTime(20)
    t('c')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('fires again after the cooldown elapses', () => {
    const fn = vi.fn()
    const t = throttle(fn, 100)
    t('a')
    vi.advanceTimersByTime(150)
    t('b')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith('b')
  })

  it('passes all args through', () => {
    const fn = vi.fn()
    const t = throttle(fn, 100)
    t(1, 'two', { three: 3 })
    expect(fn).toHaveBeenCalledWith(1, 'two', { three: 3 })
  })
})
