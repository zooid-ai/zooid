---
"zooid": minor
"@zooid/core": minor
"@zooid/runtime-vm": minor
"@zooid/acp-client": minor
---

A `runtime: vm` agent can now reach the network and its model without holding a credential.

- `vm.allow_hosts` gives the guest a network limited to those hosts. Without it, the guest still has none.
- `vm.git` names an https remote for the guest to clone from, exposed to the agent as `ZOOID_VM_GIT`. Its host must be in `allow_hosts`.
- `vm.image` accepts a local `docker save` archive or rootfs directory (`./…`, `../…`, `/…`, `~/…`). Rebuilding the archive recreates the machine.
- A `pi` vm agent's OpenAI Codex calls go through a credential proxy on the host. The guest holds only a placeholder key, and the proxy swaps in the real one from a dedicated login at `~/.zooid/cred-proxy/pi`, which it alone refreshes. Log in once with `PI_CODING_AGENT_DIR=~/.zooid/cred-proxy/pi pi`, then `/login` → OpenAI Codex → device code.
- The zooid-tasks pi extension is no longer installed for vm agents, which have no context socket.
