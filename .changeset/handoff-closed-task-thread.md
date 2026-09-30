---
'@zooid/transport-matrix': patch
---

A `zooid_handoff` from a thread whose delegated task has already closed now wakes the callee. Before, the daemon reported `started` but dropped the handoff message, so the callee never ran.
