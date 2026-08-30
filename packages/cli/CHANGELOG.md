# zooid

## 0.11.2

### Patch Changes

- Pin the bundled `@zooid/web` to 0.10.0: fixes room history getting lost after idle gaps and inside threads, auto-selects the sole joined space when the workforce space doesn't resolve, clarifies the thread-exit button and adds a typing-gated Stop button, and repairs the e2e specs.
  - @zooid/core@0.11.2
  - @zooid/acp-client@0.11.2
  - @zooid/context-mcp@0.11.2
  - @zooid/runtime-docker@0.11.2
  - @zooid/runtime-local@0.11.2
  - @zooid/transport-http@0.11.2
  - @zooid/transport-matrix@0.11.2

## 0.11.1

### Patch Changes

- Serve `@zooid/web@0.9.1`, which fixes avatars never rendering. The web client requested avatars from the legacy unauthenticated `/_matrix/media/v3` thumbnail endpoint, which Matrix 1.11 homeservers refuse ("Unauthenticated media is disabled"), so every uploaded avatar silently fell back to the generated placeholder. `zooid dev` now serves a client that fetches them over authenticated media.
  - @zooid/core@0.11.1
  - @zooid/acp-client@0.11.1
  - @zooid/context-mcp@0.11.1
  - @zooid/runtime-docker@0.11.1
  - @zooid/runtime-local@0.11.1
  - @zooid/transport-http@0.11.1
  - @zooid/transport-matrix@0.11.1

## 0.11.0

### Minor Changes

- Run the transport-context MCP server in container runtimes (docker/podman).
  Previously `zooid-context` only worked under `runtime: local`; containerized
  agents silently saw no context tool because the emitted `mcpServers` spec used
  host paths unreachable inside the agent container. The daemon now bind-mounts a
  self-contained context-mcp bin (read-only) and the daemon socket (read-write)
  into each context-enabled agent's container and emits a container-resolved spec.

### Patch Changes

- @zooid/core@0.11.0
- @zooid/acp-client@0.11.0
- @zooid/context-mcp@0.11.0
- @zooid/runtime-docker@0.11.0
- @zooid/runtime-local@0.11.0
- @zooid/transport-http@0.11.0
- @zooid/transport-matrix@0.11.0

## 0.10.0

### Minor Changes

- Directional agent-to-agent thread handoffs (ZOD069). An agent's bare reply in a
  thread now routes only _up_ to the agent that @mentioned it (its caller), never
  back down to a callee — modeling the agent call graph as a tree rooted at the
  human. This closes the ping-pong loop hole where two agents alternating bare
  acks in a thread would trigger each other forever. Human bare replies keep the
  existing most-recent-poster behavior. Also pins the bundled web client to
  @zooid/web@0.9.0.

### Patch Changes

- @zooid/core@0.10.0
- @zooid/acp-client@0.10.0
- @zooid/context-mcp@0.10.0
- @zooid/runtime-docker@0.10.0
- @zooid/runtime-local@0.10.0
- @zooid/transport-http@0.10.0
- @zooid/transport-matrix@0.10.0

## 0.9.1

### Patch Changes

- a0590f1: `zooid init` no longer asks which model to use. Every harness (Claude Code, Codex, opencode) picks its own current default, so the wizard drops the model question entirely — and with it the hardcoded model lists that went stale on each release. opencode also defaults to the `opencode-go` provider, so the interactive flow is now just: pick a harness, then paste an API key (or nothing, on a Claude/Codex subscription). A specific model is a normal post-init edit, or can be pinned non-interactively with the optional `--model` flag (and `--provider` for opencode).
- Remote-Tuwunel (pull) mode and workstation identity:

  - Wire pull transport into the daemon — agents can connect to a remote Tuwunel via impersonated `/sync` with `since`-token persistence (remote-Tuwunel mode).
  - Slug-aware workstation identity & registration.
  - Create workstation rooms as the AS bot rather than the agent.
  - Show the actual bound UI port in startup output.

- 6337629: Workstation-derived agent MXID default (ZOD067):

  - When a transport declares a `workstation:` and an agent has no explicit `user_id`, the agent's MXID now defaults to `@{workstation}.{name}` instead of `@{name}` — so it lands inside the AS's exclusive `@{workstation}\..*` namespace rather than being rejected (`M_EXCLUSIVE`).
  - `zooid init` now scaffolds `workstation: dev` with a push/pull-mode comment, and no hand-written per-agent `user_id`.
  - @zooid/core@0.9.1
  - @zooid/acp-client@0.9.1
  - @zooid/context-mcp@0.9.1
  - @zooid/runtime-docker@0.9.1
  - @zooid/runtime-local@0.9.1
  - @zooid/transport-http@0.9.1
  - @zooid/transport-matrix@0.9.1

## 0.9.0

### Minor Changes

- Rename the Matrix wire-event prefix `eco.zoon.*` → `dev.zooid.*` (clean break, no dual-read) and switch the bundled web client to `@zooid/web` (the renamed Zooid web client, pinned at 0.7.0). The daemon emits `dev.zooid.*` events from the Matrix transport, ACP client, and daemon startup.

### Patch Changes

- @zooid/core@0.9.0
- @zooid/acp-client@0.9.0
- @zooid/context-mcp@0.9.0
- @zooid/runtime-docker@0.9.0
- @zooid/runtime-local@0.9.0
- @zooid/transport-http@0.9.0
- @zooid/transport-matrix@0.9.0

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
