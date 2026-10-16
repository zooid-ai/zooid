---
'@zooid/transport-matrix': patch
---

End a silent turn promptly. When the agent sent no session update at all, the post-turn drain now stops after 3 s instead of the 30 s cap, so the typing indicator clears and `dev.zooid.turn.end` is sent without the long hold. Turns with any activity keep the full cap for late opencode chunks.
