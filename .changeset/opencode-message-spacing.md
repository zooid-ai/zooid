---
"@zooid/acp-client": patch
"@zooid/transport-matrix": patch
---

Fix opencode agent messages running together without spacing. opencode streams
each assistant message under its own `messageId` with no delimiter chunk between
them, so consecutive messages (e.g. conversational text followed by a structured
result after a tool call) were concatenated with no separator ("…one.🅿️"). The
Matrix transport now inserts a paragraph break when the `messageId` changes, in
addition to the existing empty-chunk signal; tokens within a single message
still concatenate raw so streaming is unaffected.
