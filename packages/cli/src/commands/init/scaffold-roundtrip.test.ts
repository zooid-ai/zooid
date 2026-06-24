import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadZooidConfig, findMatrixTransport } from '@zooid/core'
import { generateZooidYaml } from './generators.js'

describe('zooid init scaffold round-trips into an in-namespace agent MXID', () => {
  // The scaffold declares no explicit tokens; loadZooidConfig infers them from
  // the environment (the real daemon supplies them — `zooid dev` generates them).
  beforeEach(() => {
    process.env.MATRIX_AS_TOKEN = 'as-test'
    process.env.MATRIX_HS_TOKEN = 'hs-test'
  })
  afterEach(() => {
    delete process.env.MATRIX_AS_TOKEN
    delete process.env.MATRIX_HS_TOKEN
  })

  it('the generated workstation scaffold parses to @dev.zooid-assistant inside the exclusive namespace', () => {
    const yaml = generateZooidYaml({ preset: 'claude' })
    const config = loadZooidConfig(yaml)

    // Workstation drove the registration namespace...
    const tx = findMatrixTransport(config)!.transport
    expect(config.workstation).toBe('dev')
    expect(tx.sender_localpart).toBe('dev')
    expect(tx.user_namespace).toBe('@dev\\..*:localhost')

    // ...and the agent MXID was derived to sit inside it (no hand-written user_id).
    const mxid = config.agents['zooid-assistant']!.matrix!.user_id
    expect(mxid).toBe('@dev.zooid-assistant:localhost')
    expect(new RegExp(`^${tx.user_namespace}$`).test(mxid)).toBe(true)
  })

  it('the opencode scaffold derives the same way (preset has no model)', () => {
    const yaml = generateZooidYaml({ preset: 'opencode' })
    const config = loadZooidConfig(yaml)
    expect(config.agents['zooid-assistant']!.matrix!.user_id).toBe('@dev.zooid-assistant:localhost')
  })
})
