import { describe, expect, it } from 'vitest'
import { buildRunArgs } from './tuwunel.js'

describe('buildRunArgs', () => {
  const base = {
    name: 'zooid-tuwunel',
    image: 'ghcr.io/matrix-construct/tuwunel:latest',
    hostPort: 8448,
    paths: {
      dataDir: '/abs/data/matrix',
      dbDir: '/abs/data/matrix/db',
      mediaDir: '/abs/data/matrix/media',
      configDir: '/abs/data/matrix/config',
      registrationsDir: '/abs/data/matrix/config/registrations',
      tuwunelTomlPath: '/abs/data/matrix/config/tuwunel.toml',
      appserviceYamlPath: '/abs/data/matrix/config/registrations/zooid.yaml',
      envPath: '/abs/data/matrix/config/.env',
    },
  }

  it('uses docker by default, mounts persistent volumes and config read-only', () => {
    const args = buildRunArgs({ ...base, engine: 'docker' })
    expect(args[0]).toBe('run')
    expect(args).toContain('--rm')
    // Foregrounded so the parent process owns Tuwunel's stdio (logs).
    expect(args).not.toContain('-d')
    expect(args).toContain('--name')
    expect(args).toContain('zooid-tuwunel')
    expect(args).toContain('-p')
    expect(args).toContain('8448:8448')
    expect(args).toContain('/abs/data/matrix/db:/var/lib/tuwunel/db')
    expect(args).toContain('/abs/data/matrix/media:/var/lib/tuwunel/media')
    expect(args).toContain(
      '/abs/data/matrix/config/tuwunel.toml:/etc/tuwunel/tuwunel.toml:ro',
    )
    expect(args).toContain(
      '/abs/data/matrix/config/registrations:/var/lib/tuwunel/registrations:ro',
    )
    expect(args).toContain('TUWUNEL_CONFIG=/etc/tuwunel/tuwunel.toml')
    expect(args[args.length - 1]).toBe(base.image)
  })

  it('engine: podman switches the binary (caller chooses), args are identical', () => {
    const docker = buildRunArgs({ ...base, engine: 'docker' })
    const podman = buildRunArgs({ ...base, engine: 'podman' })
    expect(podman).toEqual(docker)
  })

  it('honors a custom container name and host port', () => {
    const args = buildRunArgs({
      ...base,
      name: 'my-zooid-tuwunel',
      hostPort: 9000,
      engine: 'docker',
    })
    expect(args).toContain('my-zooid-tuwunel')
    expect(args).toContain('9000:8448')
  })
})
