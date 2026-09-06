# @zooid/acp-client

## 0.13.0

## 0.12.0

### Minor Changes

- Add `pi` as a first-party agent preset, end to end.

  `acp: { preset: pi }` now resolves to the `pi-acp` adapter and the
  `ghcr.io/zooid-ai/agent-pi` image, with a `~/.pi` home mount so a host login
  carries into a container.

  `zooid init` offers `pi` as a fourth choice. Because pi ignores project-level
  settings under `pi-acp`, the wizard relocates the agent's config directory into
  the project (`PI_CODING_AGENT_DIR=.pi-agent`) rather than writing to your
  `~/.pi`, and seeds it with a working provider/model — inherited from your own
  `~/.pi/agent/settings.json` when you have one, since a pair you already run
  beats any default we could guess. If a pi login is detected, the wizard _offers_
  to share it, linking `auth.json` rather than copying it so the agent stays on
  the same token lineage as your rotations; choosing a separate API key is always
  available, and is the default when no login is found.

## 0.11.2

## 0.11.1

## 0.11.0

## 0.10.0

## 0.9.1

## 0.9.0

## 0.8.0

### Minor Changes

- fetch zoon from npm registry, agent media pipeline

## 0.7.4

### Patch Changes

- 85abdbc: Fix opencode agent messages running together without spacing. opencode streams
  each assistant message under its own `messageId` with no delimiter chunk between
  them, so consecutive messages (e.g. conversational text followed by a structured
  result after a tool call) were concatenated with no separator ("…one.🅿️"). The
  Matrix transport now inserts a paragraph break when the `messageId` changes, in
  addition to the existing empty-chunk signal; tokens within a single message
  still concatenate raw so streaming is unaffected.

## 0.7.3

## 0.7.2

## 0.7.1

### Patch Changes

- 37d1494: 1. Codex acp fix 2. Container mounts - workspace auto-bind, home/data and config dirs from daemon $HOME 3. Image pre-pull with streaming progress 4. Error timeline events in zoon
