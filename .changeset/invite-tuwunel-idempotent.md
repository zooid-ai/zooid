---
"@zooid/transport-matrix": patch
---

`MatrixClient.invite()` now also swallows Tuwunel's idempotent
"cannot invite user that is joined or banned" 403, in addition to
Synapse's "already in the room / already invited" phrasings.

Previously, restarting the daemon on an already-bootstrapped Tuwunel
homeserver emitted a misleading "[matrix] space membership for ... failed"
warning every time, because the agent was already a space member and
Tuwunel surfaces that as the "joined or banned" 403 (one error string for
both cases). The bot-pool's outer try-catch already prevented this from
being a real failure, so the change is purely log-noise cleanup. If the
agent is genuinely banned, the subsequent joinRoom call surfaces that
explicitly.
