# opencode + Vertex Gemini 3.1 Pro — Reviewer

A zooid example that runs **opencode** (ACP mode) against **Vertex Gemini 3.1 Pro**
and asks it to find a real correctness bug in a small throttle utility.

This is a working showcase of three things at once:

1. The zooid daemon orchestrating an ACP shim that isn't Claude.
2. opencode authenticating to Vertex via an Express API key (no service
   account, no `gcloud auth`).
3. The Plan-02 approval round-trip — the agent has to ask permission
   to write its finding, and you grant it via HTTP.

## What the agent does

It reads `src/throttle.ts` and `src/throttle.test.ts`, identifies a bug
the tests don't catch (the throttle contract promises a trailing-edge
fire of the latest args, but the implementation drops them silently),
and writes a structured `FINDING-<utc>.md` file under `findings/`.

## Setup

1. **Drop your Vertex Express API key into `.env`** (gitignored):

   ```env
   GOOGLE_VERTEX_API_KEY="AQ.Ab8R..."
   ```

   Express keys carry their own project/location — you do **not** need
   `GOOGLE_CLOUD_PROJECT`, `VERTEX_LOCATION`, or
   `GOOGLE_APPLICATION_CREDENTIALS`. If you don't have one,
   [enable Express mode here](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/overview).

2. **Make sure `opencode` is on your PATH.** The `opencode` preset in
   our daemon resolves to `opencode acp`; if that command doesn't run
   from a fresh shell, fix your install before going further.

3. **Mint a daemon token:**

   ```bash
   export ZOOID_TOKEN=$(openssl rand -hex 32)
   ```

## Run it

From this directory:

```bash
# Load the Vertex API key into the daemon's env.
set -a && source .env && set +a

zooid --port 8080
```

In another terminal, start a session and **leave the SSE connection
open**:

```bash
curl -N http://localhost:8080/agents/reviewer/sessions \
  -H "Authorization: Bearer $ZOOID_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"review src/throttle.ts and write a finding"}' \
  | tee /tmp/reviewer.sse
```

The stream emits ACP events as the agent reads files, then surfaces
`approval.request` frames when it wants to write. In a third terminal,
allow each one:

```bash
SID=$(grep '"type":"session.start"' /tmp/reviewer.sse \
  | sed -E 's/.*"session_id":"([^"]+)".*/\1/' | head -1)
APPROVAL=$(grep '"type":"approval.request"' /tmp/reviewer.sse \
  | sed -E 's/.*"approval_id":"([^"]+)".*/\1/' | tail -1)

curl -X POST \
  "http://localhost:8080/agents/reviewer/sessions/$SID/approvals/$APPROVAL" \
  -H "Authorization: Bearer $ZOOID_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"decision":"allow","option_id":"allow-once"}'
```

When the SSE stream ends with `{"type":"turn.end","stop_reason":"end_turn"}`,
check `findings/` for the new markdown file.

## Files

| Path | Purpose |
|---|---|
| `zooid.yaml` | zooid config — `acp: { preset: opencode }`, runtime: local |
| `opencode.json` | Pins the model (`google-vertex/gemini-3.1-pro-preview`) |
| `AGENTS.md` | The reviewer's job description and finding format |
| `src/throttle.ts` | The implementation under review |
| `src/throttle.test.ts` | Its existing (incomplete) test suite |
| `findings/` | Where the agent writes its output |
| `.env` | (gitignored) `GOOGLE_VERTEX_API_KEY` for opencode |

## Why this example

The triage-agent example showcases Claude Code on a real monorepo.
This one is deliberately smaller and focused on a single judgement
call — useful for verifying that:

- A non-Claude ACP agent works end-to-end through the zooid daemon.
- Vertex Express-mode auth is enough; we don't need `gcloud auth` or
  a service-account JSON.
- The model engages with workspace files in a way that's checkable —
  if the bug it identifies isn't the trailing-edge issue, you know
  the integration is degraded somehow.
