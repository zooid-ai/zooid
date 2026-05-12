# ux-consultant capture script

Drives Playwright against the running Zoon UI and saves screenshots that
the ux-consultant agent can Read for actual visual review.

## Usage

```bash
# from agents/ux-consultant/
pnpm install              # one-time: installs playwright + downloads chromium
pnpm capture              # captures every scenario in scenarios.json
```

Output:

```
screenshots/
  2026-05-12T16-30-00-000Z/
    home/
      desktop.png
      mobile.png
    welcome-room/
      desktop.png
      mobile.png
    ...
  latest -> 2026-05-12T16-30-00-000Z
```

The agent can `Read` any PNG path directly — Claude Code surfaces images
inline.

## Configuration

- **`ZOON_URL`** (env, default `http://localhost:5173`) — target the
  bundled Zoon UI exposed by `zooid dev`.
- **`SCENARIOS`** (env, default `scenarios.json`) — alternate scenario
  file in the same directory.

## Adding scenarios

Edit `scenarios.json`:

```json
{
  "scenarios": [
    { "name": "approval-card", "path": "/room/#welcome:localhost", "settle_ms": 800 }
  ]
}
```

`settle_ms` waits past `networkidle` for late-rendering content (animations,
deferred fetches).

## For the agent

After running `pnpm capture`, the latest snapshot is symlinked at
`screenshots/latest/`. Read each PNG and apply UX skills (heuristic review,
cognitive load review, etc.) to give targeted feedback.
