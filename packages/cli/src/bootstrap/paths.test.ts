import { describe, expect, it } from 'vitest'
import { resolvePaths } from './paths.js'

describe('resolvePaths', () => {
  it('builds the canonical layout under the data dir', () => {
    const p = resolvePaths('/tmp/zooid/data/matrix')
    expect(p.dbDir).toBe('/tmp/zooid/data/matrix/db')
    expect(p.mediaDir).toBe('/tmp/zooid/data/matrix/media')
    expect(p.configDir).toBe('/tmp/zooid/data/matrix/config')
    expect(p.registrationsDir).toBe('/tmp/zooid/data/matrix/config/registrations')
    expect(p.tuwunelTomlPath).toBe('/tmp/zooid/data/matrix/config/tuwunel.toml')
    expect(p.appserviceYamlPath).toBe('/tmp/zooid/data/matrix/config/registrations/zooid.yaml')
    expect(p.envPath).toBe('/tmp/zooid/data/matrix/config/.env')
  })

  it('handles relative paths by leaving them relative (caller normalizes)', () => {
    const p = resolvePaths('./data/matrix')
    expect(p.dbDir).toBe('data/matrix/db')
  })
})
