# zooid

## 0.8.0

### Minor Changes

- fetch zoon from npm registry, agent media pipeline

### Patch Changes

- Updated dependencies
  - @zooid/acp-client@0.8.0
  - @zooid/context-mcp@0.8.0
  - @zooid/core@0.8.0
  - @zooid/runtime-docker@0.8.0
  - @zooid/runtime-local@0.8.0
  - @zooid/transport-http@0.8.0
  - @zooid/transport-matrix@0.8.0

## 0.7.4

### Patch Changes

- Updated dependencies [85abdbc]
  - @zooid/acp-client@0.7.4
  - @zooid/transport-matrix@0.7.4
  - @zooid/core@0.7.4
  - @zooid/context-mcp@0.7.4
  - @zooid/runtime-docker@0.7.4
  - @zooid/runtime-local@0.7.4
  - @zooid/transport-http@0.7.4

## 0.7.3

### Patch Changes

- Updated dependencies
- Updated dependencies [13383ea]
  - @zooid/transport-matrix@0.7.3
  - @zooid/core@0.7.3
  - @zooid/acp-client@0.7.3
  - @zooid/context-mcp@0.7.3
  - @zooid/runtime-docker@0.7.3
  - @zooid/runtime-local@0.7.3
  - @zooid/transport-http@0.7.3

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

- Updated dependencies [12b31de]
- Updated dependencies
  - @zooid/transport-matrix@0.7.2
  - @zooid/core@0.7.2
  - @zooid/acp-client@0.7.2
  - @zooid/context-mcp@0.7.2
  - @zooid/runtime-docker@0.7.2
  - @zooid/runtime-local@0.7.2
  - @zooid/transport-http@0.7.2

## 0.7.1

### Patch Changes

- 37d1494: 1. Codex acp fix 2. Container mounts - workspace auto-bind, home/data and config dirs from daemon $HOME 3. Image pre-pull with streaming progress 4. Error timeline events in zoon
- Updated dependencies [37d1494]
  - @zooid/acp-client@0.7.1
  - @zooid/context-mcp@0.7.1
  - @zooid/core@0.7.1
  - @zooid/runtime-docker@0.7.1
  - @zooid/runtime-local@0.7.1
  - @zooid/transport-http@0.7.1
  - @zooid/transport-matrix@0.7.1
