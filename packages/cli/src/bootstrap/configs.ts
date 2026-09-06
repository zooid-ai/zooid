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
    // NOT `suppress_push_when_active` ([[ZNC025]]). It reads Matrix presence,
    // which is both too coarse and too slow for this: coarse because it is
    // per-user, so reading room A kills the push for room B; slow because
    // `currently_active` lingers for minutes after the last sync, so closing
    // the tab and waiting for an agent to finish still delivers nothing —
    // exactly the case this feature exists for. `public/sw.js` already does
    // the suppression we actually want, precisely: it drops a push only when
    // a *visible* window is on *that* room.
    // DEV ONLY — disables an SSRF guard. Tuwunel is in Podman and the push
    // gateway runs on the host, so the default ip_range_denylist (127/8,
    // 10/8, 172.16/12, 192.168/16, ::1) silently drops every pusher delivery.
    // Never set on a box: there the gateway is reached at the public
    // hostname through Caddy.
    'ip_range_denylist = []',
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
  /** Workstation id. When set: registration id = workstation, exclusive namespace, url derived from port/advertise_url. */
  workstation?: string
  /** AS HTTP listener port. Used to derive the registration url when workstation is set. */
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

  const id = opts.workstation ?? 'zooid'
  const url = opts.workstation
    ? deriveRegistrationUrl({ port: opts.port ?? 9099, advertise_url: opts.advertiseUrl })
    : `http://host.docker.internal:9099`
  const exclusive = !!opts.workstation
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
