---
"zooid": minor
"@zooid/core": minor
"@zooid/runtime-vm": minor
---

Per-agent `runtime:` — a workforce can mix `local`, `docker`/`podman` and the
new `vm` runtime, which runs an agent's ACP process in its own smolvm
microVM with its workdir mounted read-only. Context tools and guest
networking are not available under `vm` yet.
