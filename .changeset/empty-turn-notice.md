---
'@zooid/transport-matrix': patch
---

A turn that ends cleanly without producing any output now posts a short "produced no output, check the daemon log" notice in the thread, before `dev.zooid.turn.end`, instead of staying silent (zooid#16). Turns that throw are unchanged.
