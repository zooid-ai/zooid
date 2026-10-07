---
'@zooid/transport-matrix': patch
---

`zooid_get_history` and `zooid_get_recent_threads` no longer report `has_more: true` forever at the start of a room's history: `has_more` and `next_before` now come from peeking one event past the `/messages` cursor instead of from cursor presence (zooid#111).
