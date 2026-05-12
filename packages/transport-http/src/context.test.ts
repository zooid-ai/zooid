import { describe, it, expect } from 'vitest'
import { getContextProvider } from './context.js'

describe('transport-http context surface', () => {
  it('returns null — HTTP has no durable conversation context in MVP (see ZOD046)', () => {
    expect(getContextProvider()).toBeNull()
  })
})
