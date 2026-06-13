# @zooid/transport-matrix

## 0.8.0

### Minor Changes

- fetch zoon from npm registry, agent media pipeline

### Patch Changes

- Updated dependencies
  - @zooid/acp-client@0.8.0
  - @zooid/core@0.8.0

## 0.7.4

### Patch Changes

- 85abdbc: Fix opencode agent messages running together without spacing. opencode streams
  each assistant message under its own `messageId` with no delimiter chunk between
  them, so consecutive messages (e.g. conversational text followed by a structured
  result after a tool call) were concatenated with no separator ("…one.🅿️"). The
  Matrix transport now inserts a paragraph break when the `messageId` changes, in
  addition to the existing empty-chunk signal; tokens within a single message
  still concatenate raw so streaming is unaffected.
- Updated dependencies [85abdbc]
  - @zooid/acp-client@0.7.4
  - @zooid/core@0.7.4

## 0.7.3

### Patch Changes

- Drain trailing `agent_message_chunk`s when the stream starts _after_ the
  prompt promise resolves.

  Some ACP agents (opencode in particular) resolve `session/prompt` before
  the agent_message_chunk stream begins — sometimes by 5–15 seconds. The
  previous drain logic broke out of the wait loop as soon as the buffer
  had been empty for 300 ms, which meant those late-starting chunks were
  missed and the turn ended with "turn finished with empty buffer; nothing
  sent."

  Two changes:

  - The drain loop now only short-circuits when the buffer has content _and_
    has stopped growing — an unchanged empty buffer means the stream hasn't
    started yet, so we keep waiting.
  - `DRAIN_MAX_MS` raised from 3 s to 30 s. The drain still exits early via
    `DRAIN_QUIET_MS` (300 ms) once any content has settled, so this cap only
    matters for genuinely stuck turns.

- 13383ea: `MatrixClient.invite()` now also swallows Tuwunel's idempotent
  "cannot invite user that is joined or banned" 403, in addition to
  Synapse's "already in the room / already invited" phrasings.

  Previously, restarting the daemon on an already-bootstrapped Tuwunel
  homeserver emitted a misleading "[matrix] space membership for ... failed"
  warning every time, because the agent was already a space member and
  Tuwunel surfaces that as the "joined or banned" 403 (one error string for
  both cases). The bot-pool's outer try-catch already prevented this from
  being a real failure, so the change is purely log-noise cleanup. If the
  agent is genuinely banned, the subsequent joinRoom call surfaces that
  explicitly.

  - @zooid/core@0.7.3
  - @zooid/acp-client@0.7.3

## 0.7.2

### Patch Changes

- 12b31de: Drain trailing `agent_message_chunk`s after a turn resolves. ACP does not
  guarantee that all `session/update` notifications precede the `session/prompt`
  response for a normal turn (only the cancellation path mandates it), and some
  agents (e.g. opencode) flush a final chunk just after the stop reason. The
  transport now waits for the per-session buffer to stay quiet for a short grace
  window (debounced, capped) before sending, instead of flushing the moment
  `prompt()` resolves — which previously truncated or dropped replies.
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

- Updated dependencies
  - @zooid/core@0.7.2
  - @zooid/acp-client@0.7.2

## 0.7.1

### Patch Changes

- 37d1494: 1. Codex acp fix 2. Container mounts - workspace auto-bind, home/data and config dirs from daemon $HOME 3. Image pre-pull with streaming progress 4. Error timeline events in zoon
- Updated dependencies [37d1494]
  - @zooid/acp-client@0.7.1
  - @zooid/core@0.7.1
