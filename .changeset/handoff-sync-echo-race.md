---
'@zooid/transport-matrix': patch
'@zooid/core': patch
---

A `zooid_handoff` inside an open delegated task now wakes the callee even when the homeserver's sync delivers the handoff message before the send call returns. Before, the daemon reported `started` but sometimes dropped the message, so the callee never ran and the caller waited forever.
