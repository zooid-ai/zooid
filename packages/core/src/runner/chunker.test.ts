import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Chunker } from './chunker.js'

describe('Chunker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('flushes after idle timeout', () => {
    const flushes: string[][] = []
    const chunker = new Chunker({
      idleMs: 3000,
      maxBytes: 64 * 1024,
      onFlush: (chunks) => flushes.push(chunks),
    })

    chunker.write('hello ')
    chunker.write('world')
    expect(flushes).toHaveLength(0)

    vi.advanceTimersByTime(2999)
    expect(flushes).toHaveLength(0)

    vi.advanceTimersByTime(1)
    expect(flushes).toEqual([['hello ', 'world']])
  })

  it('idle timer resets on new write', () => {
    const flushes: string[][] = []
    const chunker = new Chunker({
      idleMs: 3000,
      maxBytes: 64 * 1024,
      onFlush: (c) => flushes.push(c),
    })

    chunker.write('one')
    vi.advanceTimersByTime(2000)
    chunker.write('two')
    vi.advanceTimersByTime(2000)
    expect(flushes).toHaveLength(0) // still within idle since "two"
    vi.advanceTimersByTime(1000)
    expect(flushes).toEqual([['one', 'two']])
  })

  it('flushes when buffer exceeds maxBytes', () => {
    const flushes: string[][] = []
    const chunker = new Chunker({
      idleMs: 3000,
      maxBytes: 10,
      onFlush: (c) => flushes.push(c),
    })

    chunker.write('short')
    expect(flushes).toHaveLength(0)
    chunker.write('definitely-over-ten-bytes')
    expect(flushes).toHaveLength(1)
    expect(flushes[0]).toEqual(['short', 'definitely-over-ten-bytes'])
  })

  it('flushes on end() with buffered data', () => {
    const flushes: string[][] = []
    const chunker = new Chunker({
      idleMs: 3000,
      maxBytes: 64 * 1024,
      onFlush: (c) => flushes.push(c),
    })
    chunker.write('final output')
    chunker.end()
    expect(flushes).toEqual([['final output']])
  })

  it('end() with empty buffer emits nothing', () => {
    const flushes: string[][] = []
    const chunker = new Chunker({
      idleMs: 3000,
      maxBytes: 64 * 1024,
      onFlush: (c) => flushes.push(c),
    })
    chunker.end()
    expect(flushes).toHaveLength(0)
  })
})
