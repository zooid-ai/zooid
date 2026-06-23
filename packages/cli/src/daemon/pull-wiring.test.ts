import { describe, expect, it } from 'vitest'
import { shouldBindHttpListener } from './pull-wiring.js'

describe('shouldBindHttpListener', () => {
  it('binds in appservice (push) mode — homeserver pushes to the daemon', () => {
    expect(shouldBindHttpListener('appservice')).toBe(true)
  })
  it('does NOT bind in client (pull) mode — daemon polls outbound /sync', () => {
    expect(shouldBindHttpListener('client')).toBe(false)
  })
  it('defaults to binding when mode is undefined', () => {
    expect(shouldBindHttpListener(undefined)).toBe(true)
  })
})
