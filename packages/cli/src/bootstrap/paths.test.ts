import { describe, expect, it } from 'vitest'
import { resolvePaths } from './paths.js'

// `resolvePaths` continues to take the *matrix-specific* dir.
// Callers now pass `${dataRoot}/matrix` (computed via resolveDataLayout).
describe('resolvePaths', () => {
  it('builds the canonical layout under the matrix dir', () => {
    const p = resolvePaths('/abs/data/matrix')
    expect(p.dbDir).toBe('/abs/data/matrix/db')
    expect(p.mediaDir).toBe('/abs/data/matrix/media')
    expect(p.configDir).toBe('/abs/data/matrix/config')
    expect(p.registrationsDir).toBe('/abs/data/matrix/config/registrations')
    expect(p.tuwunelTomlPath).toBe('/abs/data/matrix/config/tuwunel.toml')
    expect(p.appserviceYamlPath).toBe('/abs/data/matrix/config/registrations/zooid.yaml')
    expect(p.envPath).toBe('/abs/data/matrix/config/.env')
  })

  it('handles relative paths by leaving them relative (caller normalizes)', () => {
    const p = resolvePaths('./data/matrix')
    expect(p.dbDir).toBe('data/matrix/db')
  })
})
