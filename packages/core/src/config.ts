import { parse } from 'yaml'
import type { BuddConfig, CliFlags, DockerConfig, HomeMount } from './types.js'

export const DEFAULT_DOCKER_IMAGE = 'budd/claude-code:latest'

function parseHomeMounts(raw: unknown): HomeMount[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const mounts: HomeMount[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const path = entry.path
    const mode = entry.mode
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error(`home_mounts[].path must be a non-empty string`)
    }
    if (mode !== 'ro' && mode !== 'rw') {
      throw new Error(`home_mounts[].mode must be "ro" or "rw" (got "${mode}")`)
    }
    mounts.push({ path, mode })
  }
  return mounts.length > 0 ? mounts : undefined
}

export function loadConfig(yamlText: string): BuddConfig {
  const raw = parse(yamlText) ?? {}
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('daemon.yaml must be a YAML object')
  }

  const transport = raw.transport ?? 'http'
  if (transport !== 'http') {
    throw new Error(
      `transport must be "http" (got "${transport}"). Slack and Zooid transports are not in the MVP — see spec 031.`,
    )
  }

  // Default flips to docker now that the docker runtime is available — the
  // Docker base image is the supported deployment target. Users on the
  // local runtime must opt in explicitly with `runtime: local`.
  const runtime = raw.runtime ?? 'docker'
  if (runtime !== 'local' && runtime !== 'docker') {
    throw new Error(`runtime must be "local" or "docker" (got "${runtime}")`)
  }

  const port = raw.port ?? 8080
  if (!Number.isInteger(port)) {
    throw new Error(`port must be an integer (got ${JSON.stringify(port)})`)
  }

  const hooks: BuddConfig['hooks'] = {}
  if (raw.hooks && typeof raw.hooks === 'object') {
    if (typeof raw.hooks.pre_turn === 'string') hooks.pre_turn = raw.hooks.pre_turn
    if (typeof raw.hooks.post_turn === 'string') hooks.post_turn = raw.hooks.post_turn
  }

  const config: BuddConfig = { transport, port, runtime, hooks }

  if (runtime === 'docker') {
    const rawDocker = raw.docker && typeof raw.docker === 'object' ? raw.docker : {}
    const image =
      typeof rawDocker.image === 'string' && rawDocker.image.length > 0
        ? rawDocker.image
        : DEFAULT_DOCKER_IMAGE
    const docker: DockerConfig = { image }
    const homeMounts = parseHomeMounts(rawDocker.home_mounts)
    if (homeMounts) docker.home_mounts = homeMounts
    config.docker = docker
  }

  if (typeof raw.workdir === 'string' && raw.workdir.length > 0) {
    config.workdir = raw.workdir
  }
  return config
}

export function mergeCliFlags(base: BuddConfig, flags: CliFlags): BuddConfig {
  if (flags.transport !== undefined && flags.transport !== 'http') {
    throw new Error(
      `transport must be "http" (got "${flags.transport}"). Slack and Zooid transports are not in the MVP.`,
    )
  }
  const runtimeFlag = flags.runtime as 'local' | 'docker' | undefined
  if (
    runtimeFlag !== undefined &&
    runtimeFlag !== 'local' &&
    runtimeFlag !== 'docker'
  ) {
    throw new Error(`runtime must be "local" or "docker" (got "${flags.runtime}")`)
  }
  if (flags.port !== undefined && !Number.isInteger(flags.port)) {
    throw new Error(`port must be an integer (got ${JSON.stringify(flags.port)})`)
  }
  const runtime = runtimeFlag ?? base.runtime
  const merged: BuddConfig = {
    transport: 'http',
    port: flags.port ?? base.port,
    runtime,
    hooks: { ...base.hooks },
  }
  if (runtime === 'docker') {
    const baseDocker = base.docker ?? { image: DEFAULT_DOCKER_IMAGE }
    merged.docker = {
      image: flags.image ?? baseDocker.image,
      ...(baseDocker.home_mounts ? { home_mounts: baseDocker.home_mounts } : {}),
    }
  }
  if (flags.workdir !== undefined) {
    merged.workdir = flags.workdir
  } else if (base.workdir !== undefined) {
    merged.workdir = base.workdir
  }
  if (flags.preTurn !== undefined) merged.hooks.pre_turn = flags.preTurn
  if (flags.postTurn !== undefined) merged.hooks.post_turn = flags.postTurn
  return merged
}
