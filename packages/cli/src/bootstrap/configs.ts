import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { renderRegistration } from '@zooid/transport-matrix'
import { deriveRegistrationUrl } from './registration-url.js'
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
    'allow_local_presence = true',
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
  /** Workstation slug. When set: registration id = slug, exclusive namespace, url derived from port/advertise_url. */
  slug?: string
  /** AS HTTP listener port. Used to derive the registration url when slug is set. */
  port?: number
  /** Explicit registration url override. Mutually exclusive with port. */
  advertiseUrl?: string
}

export function writeBootstrapConfigs(opts: BootstrapConfigsOpts): void {
  const { paths, serverName, asToken, hsToken, senderLocalpart, userNamespace } = opts
  mkdirSync(paths.dbDir, { recursive: true })
  mkdirSync(paths.mediaDir, { recursive: true })
  mkdirSync(paths.registrationsDir, { recursive: true })

  writeFileSync(paths.tuwunelTomlPath, renderTuwunelToml({ serverName }))

  const id = opts.slug ?? 'zooid'
  const url = opts.slug
    ? deriveRegistrationUrl({ port: opts.port ?? 9099, advertise_url: opts.advertiseUrl })
    : `http://host.docker.internal:9099`
  const exclusive = !!opts.slug
  const registrationPath = join(paths.registrationsDir, `${id}.yaml`)

  const yaml = renderRegistration({
    id,
    url,
    homeserver: `http://localhost:${TUWUNEL_INTERNAL_PORT}`,
    asToken,
    hsToken,
    senderLocalpart,
    userNamespace,
    // BotPool.bootstrap creates `#alias:<server>` rooms when missing — the
    // AS needs an aliases namespace to legally claim them.
    aliasNamespace: `#.*:${serverName}`,
    exclusive,
  })
  writeFileSync(registrationPath, yaml)
}
