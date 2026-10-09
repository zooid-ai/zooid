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
- **No network** and **no `zooid_*` context tools** in this release.

The machine is created and started when the daemon starts, stopped (not
deleted) when it stops, and recreated when its `vm:` settings change. See
ZOD109.

## Tests

`pnpm test` runs the unit suites (and the smolvm integration file, which
skips without smolvm). `pnpm test:vm` runs the integration file through the
ZOD098 tier guard, failing if it skipped. It is deliberately not named
`test:infra`: CI's infra job runs on Linux runners without smolvm, and
`runtime: vm` is macOS-only in this release.
