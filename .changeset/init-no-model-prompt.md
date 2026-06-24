---
"zooid": patch
---

`zooid init` no longer asks which model to use. Every harness (Claude Code, Codex, opencode) picks its own current default, so the wizard drops the model question entirely — and with it the hardcoded model lists that went stale on each release. opencode also defaults to the `opencode-go` provider, so the interactive flow is now just: pick a harness, then paste an API key (or nothing, on a Claude/Codex subscription). A specific model is a normal post-init edit, or can be pinned non-interactively with the optional `--model` flag (and `--provider` for opencode).
