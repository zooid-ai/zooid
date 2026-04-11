# agentd examples

End-to-end demos of agentd configurations. Each example is a self-contained
workspace you can `cd` into and run `agentd` from.

| Example | What it shows |
|---|---|
| [`triage-agent/`](./triage-agent) | A triage agent that turns vague bug reports into structured tickets by exploring the agentd monorepo (the marketing `homepage` package in particular) and writing tickets to disk. |

Examples that target the agentd monorepo itself reach into `../../packages/`
via relative paths in their `CLAUDE.md`. To adapt them to your own monorepo,
copy the example's `CLAUDE.md` and `daemon.yaml` into a directory of your
choice and edit the workspace path inside `CLAUDE.md`.
