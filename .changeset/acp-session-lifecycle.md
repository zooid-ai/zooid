---
'@zooid/acp-client': minor
'@zooid/core': minor
'@zooid/transport-matrix': minor
'zooid': minor
---

Idle ACP sessions are now closed and their adapter processes reclaimed, so a long-running daemon no longer grows by one resident agent process (~250 MB for Claude) per thread. Each agent takes `session_idle_timeout` (`"30s"`, `"15m"`, `"2h"`, or `0` to disable; default `10m`). The next message in a reclaimed thread resumes the same session with its context intact. Idle close only applies when the adapter supports `session/close` plus resume or load; otherwise sessions stay resident and the daemon warns once. `/clear` now closes the old session before starting fresh. `zooid start` logs one `[lifecycle]` line per close and recovery.
