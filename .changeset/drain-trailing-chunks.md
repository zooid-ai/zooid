---
"@zooid/transport-matrix": patch
---

Drain trailing `agent_message_chunk`s after a turn resolves. ACP does not
guarantee that all `session/update` notifications precede the `session/prompt`
response for a normal turn (only the cancellation path mandates it), and some
agents (e.g. opencode) flush a final chunk just after the stop reason. The
transport now waits for the per-session buffer to stay quiet for a short grace
window (debounced, capped) before sending, instead of flushing the moment
`prompt()` resolves — which previously truncated or dropped replies.
