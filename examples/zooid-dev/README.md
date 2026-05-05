# `zooid dev` — minimal local workforce

A two-agent Zooid workforce that runs entirely on your laptop. Tuwunel
is managed automatically; the bundled UI is served at
`http://localhost:5173`; the agents auto-join their respective rooms
and reply to @-mentions.

## Agents

- **`@echo:localhost`** in `#welcome` — a tiny ACP shim that just
  echoes your text. No external dependencies; useful as a smoke test
  that the daemon, transport, and routing all work.
- **`@docs:localhost`** in `#docs` — `opencode` driving Vertex Gemini,
  scoped to `agents/docs/`. Reads the project's epics + source via
  symlinks under `.refs/`, writes documentation files to
  `agents/docs/output/`. Requires a working `opencode` install on
  your PATH and a Vertex Express API key.

## Run

```bash
pnpm install
pnpm zooid dev
```

Open the printed URL, log in as `admin / admin`, accept the room
invite to `#welcome`, and post:

```
@echo:localhost ping
```

The echo agent replies `echo: @echo:localhost ping`.

For the docs agent, set up Vertex first:

```bash
# In agents/docs/.env (gitignored)
GOOGLE_VERTEX_API_KEY="AQ.Ab8R..."
```

Express keys carry their own project/location — you do **not** need
`GOOGLE_CLOUD_PROJECT`, `VERTEX_LOCATION`, or
`GOOGLE_APPLICATION_CREDENTIALS`. Then in `#docs`:

```
@docs:localhost write the overview page from the shipped epics
```

The docs agent reads `.refs/epics/` and `.refs/source/`, plans, and
writes `agents/docs/output/overview.md`. (It will ask for write
permission on the first edit; approve via the daemon's approval flow
once that wires through the UI.)

## What's in this folder

- `workforce.yaml` — the workforce-as-code config consumed by
  `zooid dev`.
- `agents/echo/echo-agent.ts` — a tiny ACP-speaking shim. Read it to
  see how little code an agent needs to integrate with Zooid.
- `agents/docs/AGENTS.md` — the docs agent's procedure and rules.
- `agents/docs/.refs/{epics,source}` — symlinks into the supertree
  so the docs agent can read epic specs and package source.
- `agents/docs/output/` — where the docs agent writes.
- `data/matrix/` — created on first run; holds Tuwunel's database,
  media, and generated config. Gitignored. Delete to reset.

## Stop

`Ctrl-C` brings down the UI, daemon, and Tuwunel container in order.
The `data/` directory is preserved.

## Production?

`zooid dev` is deliberately localhost-only and ships with weak admin
credentials. For production, use `zooid start` against an
externally-managed Matrix homeserver — see the [ZOD035] spec for the
boundary.
