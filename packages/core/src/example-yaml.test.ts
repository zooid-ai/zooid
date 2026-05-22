import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { loadZooidConfig } from './config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('zooid/examples/zooid-dev/zooid.yaml', () => {
  it('parses with MATRIX_AS_TOKEN / MATRIX_HS_TOKEN set', () => {
    const prev = {
      MATRIX_AS_TOKEN: process.env.MATRIX_AS_TOKEN,
      MATRIX_HS_TOKEN: process.env.MATRIX_HS_TOKEN,
    }
    process.env.MATRIX_AS_TOKEN = 'as-tok'
    process.env.MATRIX_HS_TOKEN = 'hs-tok'
    try {
      const path = join(__dirname, '__fixtures__', 'zooid-dev.yaml')
      const yamlText = readFileSync(path, 'utf8')
      const cfg = loadZooidConfig(yamlText)
      expect(cfg.runtime).toBe('local')
      const mt = cfg.transports.matrix
      if (mt.type !== 'matrix') throw new Error('not matrix')
      expect(mt.sender_localpart).toBe('zooid')
      expect(mt.user_namespace).toBe('@.*:localhost')
      expect(cfg.agents.echo.workdir).toBe('./agents/echo')
      expect(cfg.agents.echo.matrix?.user_id).toBe('@echo:localhost')
    } finally {
      if (prev.MATRIX_AS_TOKEN === undefined) delete process.env.MATRIX_AS_TOKEN
      else process.env.MATRIX_AS_TOKEN = prev.MATRIX_AS_TOKEN
      if (prev.MATRIX_HS_TOKEN === undefined) delete process.env.MATRIX_HS_TOKEN
      else process.env.MATRIX_HS_TOKEN = prev.MATRIX_HS_TOKEN
    }
  })
})
