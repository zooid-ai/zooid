import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { loadZooidConfig, findMatrixTransport } from '@zooid/core'
import { writeBootstrapConfigs } from './configs.js'
import { resolvePaths } from './paths.js'

const YAML = `
runtime: podman
workstation: laptop
transports:
  matrix:
    homeserver: http://localhost:8448
    as_token: as-x
    hs_token: hs-x
    port: 9099
agents:
  docs: { acp: { preset: opencode }, matrix: { rooms: ['#docs'] } }
`

describe('bootstrap emits a workstation-scoped registration', () => {
  let dir: string
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('config → registration round-trip is workstation-consistent', () => {
    dir = mkdtempSync(join(tmpdir(), 'zod063-'))
    const dataDir = join(dir, 'data', 'matrix')
    const paths = resolvePaths(dataDir)
    const cfg = loadZooidConfig(YAML)
    const m = findMatrixTransport(cfg)!.transport

    writeBootstrapConfigs({
      paths,
      serverName: new URL(m.homeserver).hostname,
      asToken: 'as-x',
      hsToken: 'hs-x',
      senderLocalpart: m.sender_localpart,
      userNamespace: m.user_namespace,
      workstation: m.workstation,
      port: m.port,
    })

    const regPath = join(dataDir, 'config', 'registrations', 'laptop.yaml')
    const reg = parse(readFileSync(regPath, 'utf8'))
    expect(reg.id).toBe('laptop')
    expect(reg.sender_localpart).toBe('laptop')
    expect(reg.namespaces.users[0]).toEqual({ exclusive: true, regex: '@laptop\\..*:localhost' })
    // co-located: url advertises the daemon's bind port back to the homeserver
    expect(reg.url).toBe('http://host.docker.internal:9099')
  })
})
