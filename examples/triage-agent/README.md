# Triage Agent

An budd example that turns vague bug reports into structured engineering
tickets by exploring the budd monorepo itself. The agent reads
`../../packages/` (the real budd packages, including the marketing
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

## Running it

The fastest path is `docker compose`. From this directory:

1. Create a `.env` file (gitignored) with two values:

   ```env
   ANTHROPIC_API_KEY=sk-ant-...
   BUDD_TOKEN=<output of: openssl rand -hex 32>
   ```

2. Bring it up — this builds `ghcr.io/zooid-ai/budd-agent-claude-code:local` from the local
   workspace via `Dockerfile.local`:

   ```bash
   docker compose up --build
   ```

3. From another terminal, POST a report to the daemon:

   ```bash
   curl -N http://localhost:8080/sessions \
     -H "Authorization: Bearer $BUDD_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"prompt":"the get started button on the homepage is too small"}'
   ```

4. A new ticket file shows up in `./tickets/`.

The compose file mounts the budd repo root at `/workspace` and sets
the container's working directory to `/workspace/examples/triage-agent`,
so `CLAUDE.md`, `.claude/settings.json`, and `tickets/` are all in cwd
and `../../packages/` resolves to the real budd packages on the host.

## Files

| Path | Purpose |
|---|---|
| `docker-compose.yml` | One-command local run — builds the image from source and mounts the repo |
| `daemon.yaml` | budd configuration (transport, runtime, hooks) |
| `CLAUDE.md` | The triage agent's personality and operating rules |
| `.claude/settings.json` | Pre-approved tool permissions (read everywhere, write only to `tickets/`) |
| `tickets/` | Where the agent writes structured tickets |
| `.env` | (gitignored) Your `ANTHROPIC_API_KEY` and `BUDD_TOKEN` |

### Why `.claude/settings.json`?

budd runs Claude Code non-interactively (`claude -p …`) — there's no
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
budd monorepo. The marketing homepage is in `../../packages/homepage/`
(an Astro landing page).

## Reusing this against your own monorepo

To turn any monorepo into a triage workspace:

1. Copy `CLAUDE.md`, `daemon.yaml`, and `.claude/settings.json` into a
   directory of your choice
2. Edit `CLAUDE.md` so the workspace path matches where your `packages/`
   actually live, relative to that directory
3. `cd` into the directory and run `budd "<your report>"`

## Where to take it next

Right now this example runs as a one-shot CLI invocation. Once the
`02-budd-http`, `slack`, and `zooid` transports land, you can wire the
same `CLAUDE.md` to a Slack channel or Zooid pub/sub channel and the
triage agent will respond to messages automatically. The personality and
the target workspace stay the same; only `daemon.yaml` changes.
