# Triage Agent

A zooid example that turns vague bug reports into structured engineering
tickets by exploring the zooid monorepo itself. The agent reads
`../../packages/` (the real zooid packages, including the marketing
`homepage` package) and writes a ticket here in `tickets/`.

## What it does

You give it a fuzzy report:

> I think the 'get started' button on the homepage is too small.

The agent:

1. Reads the workspace under `../../packages/`
2. Identifies the most likely package (here, `packages/homepage`)
3. Opens the relevant source files and finds the specific component
4. Writes a structured ticket to `tickets/TICKET-<timestamp>.md`

It does **not** edit any code — its only output is a markdown ticket.

## Running it (native, no Docker)

The fastest path is to run the daemon directly against your local
`claude` CLI. From this directory:

1. Make sure `claude` is on your PATH and `ANTHROPIC_API_KEY` is set
   (the agent uses your Anthropic billing).

2. Mint a daemon token and start the daemon:

   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   export ZOOID_TOKEN=$(openssl rand -hex 32)
   zooid --port 8080
   ```

3. From another terminal, POST a report:

   ```bash
   curl -N http://localhost:8080/agents/default/sessions \
     -H "Authorization: Bearer $ZOOID_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"prompt":"the get started button on the homepage is too small"}'
   ```

4. A new ticket file shows up in `./tickets/`.

The daemon reads `daemon.yaml` from the current directory and uses `.`
as its working dir, so `CLAUDE.md`, `.claude/settings.json`, and
`tickets/` are all in cwd and `../../packages/` resolves to the real
zooid packages on disk.

## Running it (Docker)

If you'd rather containerize, `docker-compose.yml` builds a local image
from this repo's source and bind-mounts the workspace. From this
directory:

1. Create a `.env` file (gitignored) with two values:

   ```env
   ANTHROPIC_API_KEY=sk-ant-...
   ZOOID_TOKEN=<output of: openssl rand -hex 32>
   ```

2. Bring it up — this builds the local image
   `ghcr.io/zooid-ai/budd-agent-claude-code:local` from the workspace
   via `Dockerfile.local`. (The image name is a historical artefact of
   the rename and is still the published tag; don't be alarmed by the
   `budd-` prefix.)

   ```bash
   docker compose up --build
   ```

3. POST the same `curl` as in the native flow above.

The compose file mounts the zooid repo root at `/workspace` and sets
the container's working directory to `/workspace/examples/triage-agent`.

## Files

| Path | Purpose |
|---|---|
| `daemon.yaml` | zooid configuration (transport, runtime, agents) |
| `CLAUDE.md` | The triage agent's personality and operating rules |
| `.claude/settings.json` | Pre-approved tool permissions (read everywhere, write only to `tickets/`) |
| `docker-compose.yml` | Optional: containerized run that builds the image from source and mounts the repo |
| `tickets/` | Where the agent writes structured tickets |
| `.env` | (gitignored) Your `ANTHROPIC_API_KEY` and `ZOOID_TOKEN` — only needed for the Docker flow |

### Why `.claude/settings.json`?

zooid runs Claude Code non-interactively (`claude -p …`) — there's no
human at a terminal to approve tool prompts. Claude Code only uses
tools that have been pre-approved for the workspace, so this file
declares the triage agent's permission profile up front:

- **`defaultMode: dontAsk`** — any tool not in the allow list is
  auto-denied instead of prompting. This is what makes the agent safe
  to run unattended.
- **Allowed:** `Read`, `Glob`, `Grep` (so the agent can explore
  `../../packages/`), and `Edit(/tickets/**)` scoped to the tickets
  directory. The `Edit` rule covers `Write` too — Claude Code's edit
  rules apply to all file-editing tools.
- **Denied:** `Bash`, plus `Edit` rules on the workspace's own
  `CLAUDE.md` / `daemon.yaml` / `README.md` — defense in depth so the
  agent literally cannot edit its own instructions.

Path rules use gitignore semantics: a leading `/` means "relative to
the project root" (the workspace directory), so `/tickets/**` matches
`./tickets/**` from the workspace.

When you adapt this example to your own workspace, copy `.claude/settings.json`
along with `CLAUDE.md` and `daemon.yaml` and adjust the allow/deny lists to
match what your agent should be able to do.

The actual codebase being triaged lives at `../../packages/` — the real
zooid monorepo. The marketing homepage is in `../../packages/homepage/`
(an Astro landing page).

## Reusing this against your own monorepo

To turn any monorepo into a triage workspace:

1. Copy `CLAUDE.md`, `daemon.yaml`, and `.claude/settings.json` into a
   directory of your choice
2. Edit `CLAUDE.md` so the workspace path matches where your `packages/`
   actually live, relative to that directory
3. `cd` into the directory, set `ZOOID_TOKEN` and `ANTHROPIC_API_KEY`,
   and run `zooid --port 8080`
