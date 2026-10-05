---
'@zooid/transport-matrix': patch
---

Typing and presence are now the room aggregate of an agent's in-flight turns: one turn ending no longer clears another's indicator, a turn waiting on a human shows as not typing, and no refresh can outlive its turn (ZOD091, zooid#36).
