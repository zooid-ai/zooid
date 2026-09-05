---
"@zooid/transport-matrix": patch
---

Correct a misleading doc comment on `MatrixContextProviderOpts.asUserId` and
add the missing coverage for the boundary it describes. Context reads are
impersonated as the agent's own Matrix user, so the homeserver enforces access;
the comment claimed they ran as the AS bot, which reads every room. Behaviour is
unchanged — the tests pin it so a refactor can't quietly widen it.
