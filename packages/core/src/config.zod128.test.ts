import { describe, it, expect } from 'vitest'
import { loadZooidConfig } from './config.js'

const HTTP = `
transports:
  http-local:
    type: http
    port: 8080
`

function agent(name: string, extra = ''): string {
  return `  ${name}:
    workdir: ./${name}
    acp: { command: node, args: [agent.mjs] }
    http: { transport: http-local }
${extra}`
}

function yaml(top: string, ...agents: string[]): string {
  return `${top}\n${HTTP.trimStart()}agents:\n${agents.join('')}`
}

const vm = (block: string) => loadZooidConfig(yaml('runtime: vm', agent('smoke', `    vm: ${block}\n`)))

const HOSTS_MSG = /agents\.smoke\.vm\.allow_hosts must be a non-empty list of host names like "github\.com"/

describe('ZOD128: vm.git and vm.allow_hosts', () => {
  it('accepts git + allow_hosts', () => {
    const cfg = vm('{ git: "https://github.com/zooid-ai/zooid.git", allow_hosts: [github.com, ghcr.io] }')
    expect(cfg.agents.smoke!.vm).toEqual({
      git: 'https://github.com/zooid-ai/zooid.git',
      allow_hosts: ['github.com', 'ghcr.io'],
    })
  })

  it('allow_hosts alone is fine', () => {
    const cfg = vm('{ allow_hosts: [registry.npmjs.org] }')
    expect(cfg.agents.smoke!.vm?.allow_hosts).toEqual(['registry.npmjs.org'])
    expect(cfg.agents.smoke!.vm?.git).toBeUndefined()
  })

  it('rejects a non-https git', () => {
    expect(() => vm('{ git: "git@github.com:zooid-ai/zooid.git", allow_hosts: [github.com] }')).toThrow(
      'agents.smoke.vm.git must be an https:// URL (got "git@github.com:zooid-ai/zooid.git")',
    )
  })

  it('rejects an http git', () => {
    expect(() => vm('{ git: "http://github.com/x.git", allow_hosts: [github.com] }')).toThrow(
      'agents.smoke.vm.git must be an https:// URL (got "http://github.com/x.git")',
    )
  })

  it('requires the git host in allow_hosts', () => {
    expect(() => vm('{ git: "https://github.com/x.git", allow_hosts: [ghcr.io] }')).toThrow(
      'agents.smoke.vm.git host github.com is not in agents.smoke.vm.allow_hosts; the guest could not fetch from it',
    )
  })

  it('git without allow_hosts is refused the same way', () => {
    expect(() => vm('{ git: "https://github.com/x.git" }')).toThrow(
      'agents.smoke.vm.git host github.com is not in agents.smoke.vm.allow_hosts; the guest could not fetch from it',
    )
  })

  it('rejects an empty allow_hosts', () => {
    expect(() => vm('{ allow_hosts: [] }')).toThrow(HOSTS_MSG)
  })

  it.each(['https://github.com', 'github.com:443', 'github.com/x', '*.github.com'])(
    'rejects %s in allow_hosts, naming it',
    (bad) => {
      expect(() => vm(`{ allow_hosts: ["${bad}"] }`)).toThrow(HOSTS_MSG)
      expect(() => vm(`{ allow_hosts: ["${bad}"] }`)).toThrow(JSON.stringify(bad))
    },
  )

  it('lists the new fields in the unknown-field message', () => {
    expect(() => vm('{ mounts: [] }')).toThrow(
      'agents.smoke.vm.mounts is not a recognised field (image, cpus, memory, disk, git, allow_hosts)',
    )
  })
})
