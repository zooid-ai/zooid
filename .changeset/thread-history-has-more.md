---
'@zooid/transport-matrix': patch
---

`zooid_get_thread_history` no longer reports `has_more: true` on an exhausted thread: Tuwunel echoes `next_batch` on every page, so `has_more` and `next_before` now come from whether messages actually remain (zooid#21).
