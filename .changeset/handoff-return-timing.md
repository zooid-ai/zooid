---
'@zooid/transport-matrix': patch
---

Handoff returns wake the caller once, when the callee is actually done. A callee running tools for more than 90s no longer wakes its caller mid-turn; a turn that ends by @mentioning another agent waits for that agent's reply instead of returning; a human @mention of the caller no longer cancels a pending return; and the caller is woken with a `[handoff return] from <agent>` envelope carrying the callee's final message.
