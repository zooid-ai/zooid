---
"zooid": minor
---

Workstation-derived agent MXID default (ZOD067):

- When a transport declares a `workstation:` and an agent has no explicit `user_id`, the agent's MXID now defaults to `@{workstation}.{name}` instead of `@{name}` — so it lands inside the AS's exclusive `@{workstation}\..*` namespace rather than being rejected (`M_EXCLUSIVE`).
- `zooid init` now scaffolds `workstation: dev` with a push/pull-mode comment, and no hand-written per-agent `user_id`.
