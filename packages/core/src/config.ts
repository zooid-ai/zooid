import { parse } from 'yaml'
import type { AgentdConfig, CliFlags } from './types.js'

const DEFAULT_DOCKER_IMAGE = 'zooid/agentd-claude:latest'

export function loadConfig(yamlText: string): AgentdConfig {
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

  const hooks: AgentdConfig['hooks'] = {}
  if (raw.hooks && typeof raw.hooks === 'object') {
    if (typeof raw.hooks.pre_start === 'string') hooks.pre_start = raw.hooks.pre_start
    if (typeof raw.hooks.post_end === 'string') hooks.post_end = raw.hooks.post_end
  }

  const config: AgentdConfig = { transport, port, runtime, hooks }
  if (runtime === 'docker') {
    config.image =
      typeof raw.image === 'string' && raw.image.length > 0
        ? raw.image
        : DEFAULT_DOCKER_IMAGE
  }
  if (typeof raw.workdir === 'string' && raw.workdir.length > 0) {
    config.workdir = raw.workdir
  }
  return config
}

export function mergeCliFlags(base: AgentdConfig, flags: CliFlags): AgentdConfig {
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
  const merged: AgentdConfig = {
    transport: 'http',
    port: flags.port ?? base.port,
    runtime,
    hooks: { ...base.hooks },
  }
  if (runtime === 'docker') {
    merged.image = flags.image ?? base.image ?? DEFAULT_DOCKER_IMAGE
  }
  if (flags.workdir !== undefined) {
    merged.workdir = flags.workdir
  } else if (base.workdir !== undefined) {
    merged.workdir = base.workdir
  }
  if (flags.preStart !== undefined) merged.hooks.pre_start = flags.preStart
  if (flags.postEnd !== undefined) merged.hooks.post_end = flags.postEnd
  return merged
}
