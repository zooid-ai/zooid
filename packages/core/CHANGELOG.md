# @zooid/core

## 0.17.1

### Patch Changes

- @zooid/acp-client@0.17.1

## 0.17.0

### Minor Changes

- 0198f5f: Agents can ask a question mid-turn through ACP form elicitation. Questions appear in their Matrix thread and answers return to the same tool call and turn. Upgrades the ACP SDK to 1.5.

### Patch Changes

- 78c796b: A `zooid_handoff` inside an open delegated task now wakes the callee even when the homeserver's sync delivers the handoff message before the send call returns. Before, the daemon reported `started` but sometimes dropped the message, so the callee never ran and the caller waited forever.
- Updated dependencies [0198f5f]
  - @zooid/acp-client@0.17.0

## 0.16.1

### Patch Changes

- @zooid/acp-client@0.16.1

## 0.16.0

### Minor Changes

- ac219ba: Idle ACP sessions are now closed and their adapter processes reclaimed, so a long-running daemon no longer grows by one resident agent process (~250 MB for Claude) per thread. Each agent takes `session_idle_timeout` (`"30s"`, `"15m"`, `"2h"`, or `0` to disable; default `10m`). The next message in a reclaimed thread resumes the same session with its context intact. Idle close only applies when the adapter supports `session/close` plus resume or load; otherwise sessions stay resident and the daemon warns once. `/clear` now closes the old session before starting fresh. `zooid start` logs one `[lifecycle]` line per close and recovery.
- 1291a1b: Agents now hand off with the `zooid_handoff` tool instead of @mentioning each other. An agent's @mentions — in prose, relayed instructions, status reports or `zooid_send_message` — no longer wake other agents; human @mentions are unchanged. Handoff calls carry structured `dev.zooid.handoff` metadata keyed by Matrix ID, so a callee on another workstation now returns to its caller. **Upgrade every daemon in a workforce together:** an older daemon's agents still hand off by @mention, which newer daemons ignore. Update agent instructions that say "@mention the agent to hand off" to "call zooid_handoff".

### Patch Changes

- Updated dependencies [ac219ba]
  - @zooid/acp-client@0.16.0

## 0.15.0

### Patch Changes

- @zooid/acp-client@0.15.0

## 0.14.1

### Patch Changes

- @zooid/acp-client@0.14.1

## 0.14.0

### Patch Changes

- @zooid/acp-client@0.14.0

## 0.13.0

### Patch Changes

- @zooid/acp-client@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies
  - @zooid/acp-client@0.12.0

## 0.11.2

### Patch Changes

- @zooid/acp-client@0.11.2

## 0.11.1

### Patch Changes

- @zooid/acp-client@0.11.1

## 0.11.0

### Patch Changes

- @zooid/acp-client@0.11.0

## 0.10.0

### Patch Changes

- @zooid/acp-client@0.10.0

## 0.9.1

### Patch Changes

- @zooid/acp-client@0.9.1

## 0.9.0

### Patch Changes

- @zooid/acp-client@0.9.0

## 0.8.0

### Minor Changes

- fetch zoon from npm registry, agent media pipeline

### Patch Changes

- Updated dependencies
  - @zooid/acp-client@0.8.0

## 0.7.4

### Patch Changes

- Updated dependencies [85abdbc]
  - @zooid/acp-client@0.7.4

## 0.7.3

### Patch Changes

- @zooid/acp-client@0.7.3

## 0.7.2

### Patch Changes

- Creation-time operator and agent power levels (ZOD056); fix several
  homeserver-bootstrap edge cases exposed by ZNC010's invite-only space.

  - New `RoomBinding { alias, powerLevel? }` shape on `MatrixBinding.rooms` —
    yaml accepts both bare alias strings and `{ alias, power_level }` objects,
    normalized internally to a uniform shape.
  - `matrix-client.createRoom` accepts `userPowerLevels` and threads it into
    `power_level_content_override.users`.
  - `ensureWorkforceSpace` accepts an `admins` opt, seeds them at PL 100 in the
    space's power levels AND adds them to the createRoom invite list — PL alone
    doesn't grant membership in an invite-only space.
  - `ensureDefaultChannel` accepts an `admins` opt and seeds them at PL 100 in
    `#general`. Matches the per-room PL semantics for agent rooms.
  - `bot-pool.bootstrap` accepts `adminUserIds`, builds a per-room
    `userPowerLevels` map (bot + admins at 100, plus each agent's declared PL),
    and now invites + joins every agent into the workforce space — restricted
    child rooms then satisfy their allow rule automatically with no per-room
    agent invites.
  - New `MatrixClient.invite()` method, idempotent against the "already in
    room" 403 surfaced by Tuwunel/Synapse.
  - `transports.matrix.port` default changed from 8080 → 9000, matching the
    conventional Matrix AS port used by Synapse, mautrix, and the
    matrix-appservice-\* family. Anyone with `port:` set explicitly in
    zooid.yaml is unaffected.
  - @zooid/acp-client@0.7.2

## 0.7.1

### Patch Changes

- 37d1494: 1. Codex acp fix 2. Container mounts - workspace auto-bind, home/data and config dirs from daemon $HOME 3. Image pre-pull with streaming progress 4. Error timeline events in zoon
- Updated dependencies [37d1494]
  - @zooid/acp-client@0.7.1
