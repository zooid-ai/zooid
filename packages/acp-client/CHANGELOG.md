# @zooid/acp-client

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
