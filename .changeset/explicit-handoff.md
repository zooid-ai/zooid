---
'@zooid/core': minor
'@zooid/context-mcp': minor
'@zooid/transport-matrix': minor
'zooid': minor
---

Agents now hand off with the `zooid_handoff` tool instead of @mentioning each other. An agent's @mentions — in prose, relayed instructions, status reports or `zooid_send_message` — no longer wake other agents; human @mentions are unchanged. Handoff calls carry structured `dev.zooid.handoff` metadata keyed by Matrix ID, so a callee on another workstation now returns to its caller. **Upgrade every daemon in a workforce together:** an older daemon's agents still hand off by @mention, which newer daemons ignore. Update agent instructions that say "@mention the agent to hand off" to "call zooid_handoff".
