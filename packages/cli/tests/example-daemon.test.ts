import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadZooidConfig } from '@zooid/core'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXAMPLE = join(HERE, '..', '..', '..', 'examples', 'zooid-dev', 'zooid.yaml')

describe('examples/zooid-dev/zooid.yaml', () => {
  it('parses and declares one matrix transport with echo + docs agents', () => {
    process.env.MATRIX_AS_TOKEN = 'as-test'
    process.env.MATRIX_HS_TOKEN = 'hs-test'
    const cfg = loadZooidConfig(readFileSync(EXAMPLE, 'utf8'))
    const transports = cfg.transports ?? {}
    const matrixEntries = Object.entries(transports).filter(([, t]) => t.type === 'matrix')
    expect(matrixEntries).toHaveLength(1)
    expect(Object.keys(cfg.agents).sort()).toEqual(['docs', 'echo'])

    const echo = cfg.agents.echo!
    expect(echo.matrix?.user_id).toBe('@echo:localhost')
    expect(echo.matrix?.trigger).toBe('mention')
    expect(echo.matrix?.rooms).toEqual(['#welcome:localhost'])

    const docs = cfg.agents.docs!
    expect(docs.matrix?.user_id).toBe('@docs:localhost')
    expect(docs.matrix?.trigger).toBe('mention')
    expect(docs.matrix?.rooms).toEqual(['#docs:localhost'])
    expect(docs.acp).toEqual({ preset: 'opencode' })
  })
})
