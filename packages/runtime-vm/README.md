# @zooid/runtime-vm

`runtime: vm` for zooid: each agent runs its ACP process in its own
[smolvm](https://smolmachines.com) microVM, booted from an OCI image.

```yaml
runtime: local
agents:
  smoke:
    runtime: vm
    acp: { command: node, args: [/workspace/agent.mjs] }
    vm:
      image: node:22-alpine
      cpus: 2
      memory: 2GiB
      disk: 8GiB
```

## Install smolvm

```bash
brew install smol-machines/tap/smolvm   # macOS (Apple Silicon)
```

## What the guest gets

- **One host mount.** The agent's workdir, read-only at `/workspace`. smolvm
  enforces `:ro` host-side, so not even root in the guest can write it.
  Files the daemon writes there (inbound attachments) show up in the guest.
- **No secrets.** The daemon refuses to start if a vm agent's workdir holds
  `.env*`, `.dev.vars*` or `.claude/settings.local.json`: the guest can read
  everything in it.
- **No network unless you list hosts.** `vm.allow_hosts: [github.com, …]`
  turns on egress to exactly those hosts. `vm.git` (an https remote whose
  host is in that list) reaches the agent as `ZOOID_VM_GIT`.
- **No model credential.** A `preset: pi` agent's model calls go through a
  host-side proxy on a mounted Unix socket; the guest holds only a
  placeholder key. The proxy reads a dedicated login it alone refreshes:
  `PI_CODING_AGENT_DIR=~/.zooid/cred-proxy/pi pi`, then `/login` → OpenAI
  Codex → device code. Other presets have no proxy yet.
- **No `zooid_*` context tools** in this release.

`vm.image` is a registry reference, or a local `docker save` archive or
rootfs directory when it starts with `/`, `./`, `../` or `~/`. Rebuilding a
local archive recreates the machine.

The machine is created and started when the daemon starts, stopped (not
deleted) when it stops, and recreated when its `vm:` settings change. See
ZOD109 and ZOD128.

## Tests

`pnpm test` runs the unit suites (and the smolvm integration files, which
skip without smolvm). `pnpm test:vm` runs them through the
ZOD098 tier guard, failing if it skipped. It is deliberately not named
`test:infra`: CI's infra job runs on Linux runners without smolvm, and
`runtime: vm` is macOS-only in this release.
