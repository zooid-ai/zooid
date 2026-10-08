# @zooid/context-mcp

## 0.17.1

### Patch Changes

- @zooid/core@0.17.1

## 0.17.0

### Patch Changes

- ffa52d4: Pi agents can hand off again: the pi extension now registers `zooid_handoff` (gated on the daemon's `can_handoff`) and uses the same handoff and `zooid_send_message` text as the MCP server, now shared from `@zooid/context-mcp`.
- Updated dependencies [0198f5f]
- Updated dependencies [78c796b]
  - @zooid/core@0.17.0

## 0.16.1

### Patch Changes

- @zooid/core@0.16.1

## 0.16.0

### Minor Changes

- 1291a1b: Agents now hand off with the `zooid_handoff` tool instead of @mentioning each other. An agent's @mentions — in prose, relayed instructions, status reports or `zooid_send_message` — no longer wake other agents; human @mentions are unchanged. Handoff calls carry structured `dev.zooid.handoff` metadata keyed by Matrix ID, so a callee on another workstation now returns to its caller. **Upgrade every daemon in a workforce together:** an older daemon's agents still hand off by @mention, which newer daemons ignore. Update agent instructions that say "@mention the agent to hand off" to "call zooid_handoff".

### Patch Changes

- Updated dependencies [ac219ba]
- Updated dependencies [1291a1b]
  - @zooid/core@0.16.0

## 0.15.0

### Patch Changes

- @zooid/core@0.15.0

## 0.14.1

### Patch Changes

- @zooid/core@0.14.1

## 0.14.0

### Patch Changes

- @zooid/core@0.14.0

## 0.13.0

### Patch Changes

- @zooid/core@0.13.0

## 0.12.0

### Patch Changes

- @zooid/core@0.12.0

## 0.11.2

### Patch Changes

- @zooid/core@0.11.2

## 0.11.1

### Patch Changes

- @zooid/core@0.11.1

## 0.11.0

### Patch Changes

- @zooid/core@0.11.0

## 0.10.0

### Patch Changes

- @zooid/core@0.10.0

## 0.9.1

### Patch Changes

- @zooid/core@0.9.1

## 0.9.0

### Patch Changes

- @zooid/core@0.9.0

## 0.8.0

### Minor Changes

- fetch zoon from npm registry, agent media pipeline

### Patch Changes

- Updated dependencies
  - @zooid/core@0.8.0

## 0.7.4

### Patch Changes

- @zooid/core@0.7.4

## 0.7.3

### Patch Changes

- @zooid/core@0.7.3

## 0.7.2

### Patch Changes

- Updated dependencies
  - @zooid/core@0.7.2

## 0.7.1

### Patch Changes

- 37d1494: 1. Codex acp fix 2. Container mounts - workspace auto-bind, home/data and config dirs from daemon $HOME 3. Image pre-pull with streaming progress 4. Error timeline events in zoon
- Updated dependencies [37d1494]
  - @zooid/core@0.7.1
