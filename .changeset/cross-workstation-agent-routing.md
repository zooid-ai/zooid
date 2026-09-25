---
'@zooid/transport-matrix': patch
'zooid': patch
---

Agents on other workstations no longer read as humans. The `dev.zooid.workforce` roster is now keyed by workstation (one state event per daemon, so daemons sharing a space stop overwriting each other), each daemon merges every roster in the space, and the router treats a rostered agent — or any `m.notice` sender — as an agent: it continues a thread only by explicit @mention, never through the human follow-up rules. Fixes two daemons waking each other's agents in an endless loop.
