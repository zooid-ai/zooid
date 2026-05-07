import { describe, expect, it } from 'vitest'
import { renderTuwunelToml } from './configs.js'

describe('renderTuwunelToml', () => {
  it('emits the localhost dev profile with paranoid open registration', () => {
    const toml = renderTuwunelToml({ serverName: 'localhost' })
    expect(toml).toContain('[global]')
    expect(toml).toContain('server_name = "localhost"')
    expect(toml).toContain('database_path = "/var/lib/tuwunel/db"')
    expect(toml).toContain('media_path = "/var/lib/tuwunel/media"')
    expect(toml).toContain('appservice_dir = "/var/lib/tuwunel/registrations"')
    expect(toml).toContain('allow_registration = true')
    expect(toml).toContain(
      'yes_i_am_very_very_sure_i_want_an_open_registration_server_prone_to_abuse = true',
    )
    expect(toml).toContain('allow_local_presence = true')
    expect(toml).toContain('port = [8448]')
  })

  it('honors a non-default server_name', () => {
    const toml = renderTuwunelToml({ serverName: 'matrix.dev' })
    expect(toml).toContain('server_name = "matrix.dev"')
  })
})
