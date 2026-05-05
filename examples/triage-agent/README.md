# Triage Agent

A zooid example that turns vague bug reports into structured engineering
tickets by exploring the zooid monorepo itself. The agent reads
`../../packages/` (the real zooid packages, including the marketing
`homepage` package) and writes a ticket here in `tickets/`.

This is the canonical end-to-end smoke for the ACP-based zooid stack:
the daemon spawns the Claude Code ACP shim, surfaces tool-permission
requests over SSE, and resolves them via a HTTP `POST /approvals` round-trip.

## What it does

You give it a fuzzy report:

> I think `transport-http` is dropping events when the SSE client reconnects mid-turn.

The agent:

1. Reads the workspace under `../../packages/`
2. Identifies the most likely package (here, `packages/transport-http`)
3. Opens the relevant source files and finds the specific component
4. Asks for permission to write a new file under `tickets/`
5. Writes a structured ticket to `tickets/TICKET-<timestamp>.md`

It does **not** edit any code — its only output is a markdown ticket.

> The marketing homepage used to live at `packages/homepage` and was a
> common target for triage prompts. It now lives in the sibling repo
> `zooid-homepage/` and is out of scope for this example.

## Running it (native, no Docker)

The fastest path is to run the daemon against your local Node + the
Claude Code ACP shim (auto-installed via `npx`). From this directory:

1. Set up env:

   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   export ZOOID_TOKEN=$(openssl rand -hex 32)
   ```

2. Start the daemon:

   ```bash
   zooid --port 8080
   ```

   On first start the `claude` preset resolves to
   `npx -y @agentclientprotocol/claude-agent-acp`, so expect a one-off
   download.

3. From another terminal, POST a report — and **leave the connection
   open**. The response is a long-lived SSE stream that surfaces every
   ACP event, including the agent's permission requests:

   ```bash
   curl -N http://localhost:8080/agents/default/sessions \
     -H "Authorization: Bearer $ZOOID_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"prompt":"the get started button on the homepage is too small"}' \
     | tee /tmp/triage.sse
   ```

4. As tool calls happen, the SSE stream emits `approval.request` frames:

   ```
   data: {"type":"approval.request","approval_id":"<uuid>","session_id":"<sid>",
          "tool_call_id":"...","options":[{"optionId":"allow-once",...}, ...]}
   ```

   In a third terminal, allow the request:

   ```bash
   curl -X POST \
     "http://localhost:8080/agents/default/sessions/<sid>/approvals/<approval_id>" \
     -H "Authorization: Bearer $ZOOID_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"decision":"allow","option_id":"allow-once"}'
   ```

   To deny: `'{"decision":"cancel"}'`. To bail on the whole turn:

   ```bash
   curl -X POST \
     "http://localhost:8080/agents/default/sessions/<sid>/cancel" \
     -H "Authorization: Bearer $ZOOID_TOKEN"
   ```

5. When the SSE stream emits `{"type":"turn.end","stop_reason":"end_turn"}`,
   a new ticket file is in `./tickets/`.

The daemon reads `workforce.yaml` from the current directory and uses `.`
as its working dir, so `CLAUDE.md`, `.claude/settings.json`, and
`tickets/` are all in cwd and `../../packages/` resolves to the real
zooid packages on disk.

## Running it (Docker)

`docker-compose.yml` runs the daemon in a container based on the new
single `zooid-agent-base` image. The `claude-agent-acp` shim is fetched
on first run via `npx -y` inside the container.

1. Create a `.env` file (gitignored) with:

   ```env
   ANTHROPIC_API_KEY=sk-ant-...
   ZOOID_TOKEN=<output of: openssl rand -hex 32>
   ```

2. Bring it up:

   ```bash
   docker compose up
   ```

3. POST the same `curl` as in the native flow.

## Files

| Path | Purpose |
|---|---|
| `workforce.yaml` | zooid configuration (transport, runtime, agents) |
| `CLAUDE.md` | The triage agent's personality and operating rules |
| `.claude/settings.json` | Belt-and-suspenders pre-approved tool permissions inside the shim |
| `docker-compose.yml` | Optional: containerized run on `zooid-agent-base` |
| `tickets/` | Where the agent writes structured tickets |
| `.env` | (gitignored) Your `ANTHROPIC_API_KEY` and `ZOOID_TOKEN` — only needed for the Docker flow |

### Why `.claude/settings.json`?

ACP surfaces permissions over the transport — the daemon's
`approval.request` SSE event is the new authoritative gate. The Claude
Code shim has its own internal permission machinery that runs *before*
the ACP request hits the daemon, so `.claude/settings.json` is now a
defense-in-depth layer rather than the only line of defense:

- **`defaultMode: dontAsk`** — any tool not in the allow list is
  auto-denied inside the shim, so it never even reaches the daemon's
  ACP layer. The transport's approval round-trip handles everything else.
- **Allowed:** `Read`, `Glob`, `Grep` (workspace exploration), and
  `Edit(/tickets/**)` scoped to the tickets directory.
- **Denied:** `Bash`, plus `Edit` rules on the workspace's own
  `CLAUDE.md` / `workforce.yaml` / `README.md`.

If you want every tool call surfaced to the daemon (so you decide via
HTTP), drop the allow list and let the ACP round-trip mediate everything.

## Reusing this against your own monorepo

To turn any monorepo into a triage workspace:

1. Copy `CLAUDE.md`, `workforce.yaml`, and `.claude/settings.json` into a
   directory of your choice
2. Edit `CLAUDE.md` so the workspace path matches where your `packages/`
   actually live, relative to that directory
3. `cd` into the directory, set `ZOOID_TOKEN` and `ANTHROPIC_API_KEY`,
   and run `zooid --port 8080`
