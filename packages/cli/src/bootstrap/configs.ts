import { mkdirSync, writeFileSync } from 'node:fs'
import { renderRegistration } from '@zooid/transport-matrix'
import type { Paths } from './paths.js'

export interface TuwunelTomlOpts {
  serverName: string
}

/**
 * Tuwunel binds 8448 inside the container; the host port is whatever
 * `docker run -p <host>:8448` maps it to. So `port` here is fixed.
 */
const TUWUNEL_INTERNAL_PORT = 8448

export function renderTuwunelToml(opts: TuwunelTomlOpts): string {
  return [
    '[global]',
    `server_name = "${opts.serverName}"`,
    'database_path = "/var/lib/tuwunel/db"',
    'media_path = "/var/lib/tuwunel/media"',
    'appservice_dir = "/var/lib/tuwunel/registrations"',
    'allow_registration = true',
    'yes_i_am_very_very_sure_i_want_an_open_registration_server_prone_to_abuse = true',
    'address = ["0.0.0.0"]',
    `port = [${TUWUNEL_INTERNAL_PORT}]`,
    '',
  ].join('\n')
}

export interface BootstrapConfigsOpts {
  paths: Paths
  serverName: string
  asToken: string
  hsToken: string
  senderLocalpart: string
  userNamespace: string
}

export function writeBootstrapConfigs(opts: BootstrapConfigsOpts): void {
  const { paths, serverName, asToken, hsToken, senderLocalpart, userNamespace } = opts
  mkdirSync(paths.dbDir, { recursive: true })
  mkdirSync(paths.mediaDir, { recursive: true })
  mkdirSync(paths.registrationsDir, { recursive: true })

  writeFileSync(paths.tuwunelTomlPath, renderTuwunelToml({ serverName }))

  const yaml = renderRegistration({
    id: 'zooid',
    url: `http://host.docker.internal:9099`,
    homeserver: `http://localhost:${TUWUNEL_INTERNAL_PORT}`,
    asToken,
    hsToken,
    senderLocalpart,
    userNamespace,
    // BotPool.bootstrap creates `#alias:<server>` rooms when missing — the
    // AS needs an aliases namespace to legally claim them.
    aliasNamespace: `#.*:${serverName}`,
    // zooid dev shares @.*:<server_name> between bots and the predefined
    // admin human, so the AS cannot claim the namespace exclusively.
    exclusive: false,
  })
  writeFileSync(paths.appserviceYamlPath, yaml)
}
