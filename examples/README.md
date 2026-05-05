# budd examples

End-to-end demos of budd configurations. Each example is a self-contained
workspace you can `cd` into and run `budd` from.

| Example | What it shows |
|---|---|
| [`triage-agent/`](./triage-agent) | A triage agent that turns vague bug reports into structured tickets by exploring the budd monorepo (the marketing `homepage` package in particular) and writing tickets to disk. |

Examples that target the budd monorepo itself reach into `../../packages/`
via relative paths in their `CLAUDE.md`. To adapt them to your own monorepo,
copy the example's `CLAUDE.md` and `workforce.yaml` into a directory of your
choice and edit the workspace path inside `CLAUDE.md`.
