---
'@zooid/pi-extension': minor
'@zooid/context-mcp': patch
---

Pi agents can hand off again: the pi extension now registers `zooid_handoff` (gated on the daemon's `can_handoff`) and uses the same handoff and `zooid_send_message` text as the MCP server, now shared from `@zooid/context-mcp`.
