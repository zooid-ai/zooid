import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { PRESETS } from '@zooid/acp-client'
import { resolveAgentRuntime, type ZooidConfig } from '@zooid/core'
import {
  SMOLVM_BIN,
  buildForwarderArgv,
  defaultVmExec,
  ensureVmMachine,
  resolveVmImage,
  stopVmMachine,
  vmMachineName,
  type VmExec,
} from '@zooid/runtime-vm'
import { presetOf, resolveAgentImage } from './build-registry.js'
import { createCodexAuth, type CodexAuth } from './cred-proxy/codex-auth.js'
import { startCredentialProxy, type CredentialProxyHandle } from './cred-proxy/proxy.js'
import { credentialSocketPath } from './cred-proxy/socket-path.js'

export interface ProvisionVmsOptions {
  cfg: ZooidConfig
  configDir: string
  /** `<dataRoot>/agents/`; each machine's settings hash lives at `<agentsDir>/<agent>/vm.json`. */
  agentsDir?: string
  /** Resolves `~/` in `vm.image` and holds the proxies' logins (`~/.zooid/cred-proxy/<preset>`). */
  daemonHome?: string
  exec?: VmExec
  log?: (line: string) => void
  /** Test seam. */
  startProxy?: typeof startCredentialProxy
}

export interface VmsHandle {
  machines: string[]
  stop(): Promise<void>
}

/**
 * Bring every vm agent's machine up before the registry can spawn into it:
 * `AcpRuntime.spawn()` is synchronous, so it can only exec into a running
 * machine. Sequential on purpose — each boot is a VM. [ZOD109]
 *
 * An agent whose preset has a `vmCredential` also gets its credential proxy,
 * started first because its socket is mounted at create, then the guest
 * setup and forwarder, rerun on every start. [ZOD128]
 */
export async function provisionVms(opts: ProvisionVmsOptions): Promise<VmsHandle> {
  const exec = opts.exec ?? defaultVmExec
  const log = opts.log ?? ((l: string) => console.log(l))
  const startProxy = opts.startProxy ?? startCredentialProxy
  const home = opts.daemonHome ?? homedir()
  const stateRoot = opts.agentsDir ?? join(tmpdir(), 'zooid-vm-state')
  const machines: string[] = []
  const proxies: CredentialProxyHandle[] = []
  // One refresher per login file, however many agents share it.
  const auths = new Map<string, CodexAuth>()
  const closeProxies = async () => {
    for (const p of proxies.splice(0)) {
      await p.close().catch((err) => log(`[cred-proxy] close ${p.socketPath} failed: ${String(err)}`))
    }
  }

  try {
    for (const [name, agent] of Object.entries(opts.cfg.agents)) {
      if (resolveAgentRuntime(agent, opts.cfg) !== 'vm') continue
      const raw = resolveAgentImage(agent, opts.cfg).image
      if (!raw) {
        throw new Error(`agents.${name}: runtime: vm requires an image (set agents.${name}.vm.image)`)
      }
      const { image, stamp } = resolveVmImage(raw, opts.configDir, home)
      const machine = vmMachineName(name, opts.configDir)
      // Like the container workspace mount's `create: true`: smolvm needs the host dir to exist.
      const workdir = resolve(opts.configDir, agent.workdir)
      mkdirSync(workdir, { recursive: true })

      const preset = presetOf(agent)
      const cred = preset ? PRESETS[preset].vmCredential : undefined
      const sockets = []
      if (cred) {
        const authFile = join(cred.authDir({ daemonHome: home }), 'auth.json')
        let auth = auths.get(authFile)
        if (!auth) auths.set(authFile, (auth = createCodexAuth({ authFile })))
        const proxy = await startProxy({
          socketPath: credentialSocketPath(opts.configDir, name),
          upstream: cred.upstream,
          allowPaths: cred.allowPaths,
          auth,
          agent: name,
          log,
        })
        proxies.push(proxy)
        sockets.push({ host: proxy.socketPath, guest: cred.guestSocket })
      }

      await ensureVmMachine({
        spec: {
          name: machine,
          image,
          imageStamp: stamp,
          workdir,
          cpus: agent.vm?.cpus,
          memoryMib: agent.vm?.memory_mib,
          diskGib: agent.vm?.disk_gib,
          allowHosts: agent.vm?.allow_hosts,
          sockets,
        },
        exec,
        stateFile: join(stateRoot, name, 'vm.json'),
        log,
      })
      machines.push(machine)

      if (cred) {
        const setup = await exec(SMOLVM_BIN, ['machine', 'exec', '--name', machine, '--', 'sh', '-c', cred.guestSetup])
        if (setup.code !== 0) {
          throw new Error(
            `agents.${name}: vm guest setup failed (exit ${setup.code}):\n${setup.stderr.trim() || '(no stderr)'}`,
          )
        }
        const fwd = await exec(SMOLVM_BIN, buildForwarderArgv(machine, cred.guestPort, cred.guestSocket))
        if (fwd.code !== 0) {
          throw new Error(
            `agents.${name}: vm credential forwarder failed to start (exit ${fwd.code}):\n${fwd.stderr.trim() || '(no stderr)'}`,
          )
        }
        log(`[vm] ${machine}: model credential proxied via ${cred.guestSocket} (${cred.upstream})`)
      }
    }
  } catch (err) {
    await closeProxies()
    throw err
  }

  return {
    machines,
    async stop() {
      for (const m of machines) {
        await stopVmMachine(m, exec).catch((err) => log(`[vm] ${m}: stop failed: ${String(err)}`))
      }
      await closeProxies()
    },
  }
}
