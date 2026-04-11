# Triage Agent

An agentd example that turns vague bug reports into structured engineering
tickets by exploring the agentd monorepo itself. The agent reads
`../../packages/` (the real agentd packages, including the marketing
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

> **Not runnable yet.** This example is waiting on epic 02
> (`@zooid/agentd-transport-http`), which adds the `agentd` daemon and the
> `POST /sessions` endpoint. Once epic 02 lands you'll start the daemon
> from this directory and POST your report to it; the daemon spawns
> `claude` with this directory as its workspace, Claude Code reads
> `CLAUDE.md` on startup, and a ticket appears in `tickets/`.

## Files

| Path | Purpose |
|---|---|
| `daemon.yaml` | agentd configuration (transport, runtime, hooks) |
| `CLAUDE.md` | The triage agent's personality and operating rules |
| `tickets/` | Where the agent writes structured tickets |

The actual codebase being triaged lives at `../../packages/` — the real
agentd monorepo. The marketing homepage is in `../../packages/homepage/`
(an Astro landing page).

## Reusing this against your own monorepo

To turn any monorepo into a triage workspace:

1. Copy `CLAUDE.md` and `daemon.yaml` into a directory of your choice
2. Edit `CLAUDE.md` so the workspace path matches where your `packages/`
   actually live, relative to that directory
3. `cd` into the directory and run `agentd "<your report>"`

## Where to take it next

Right now this example runs as a one-shot CLI invocation. Once the
`02-agentd-http`, `slack`, and `zooid` transports land, you can wire the
same `CLAUDE.md` to a Slack channel or Zooid pub/sub channel and the
triage agent will respond to messages automatically. The personality and
the target workspace stay the same; only `daemon.yaml` changes.
