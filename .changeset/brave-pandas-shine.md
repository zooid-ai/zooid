---
"zooid": minor
---

Web push gateway ([ZNC025]), so agents can notify you with the browser tab
closed.

- The daemon generates a VAPID keypair on first start and serves
  `/_matrix/push/v1/notify`, encrypting each notification to the browser's push
  subscription (RFC 8291). Only 404/410 mark a pusher rejected — the homeserver
  deletes those permanently, so transient failures must not.
- `zooid dev` publishes the gateway URL and VAPID public key to the web client's
  runtime config, and no longer sets `suppress_push_when_active` in the
  generated `tuwunel.toml`: it keys off Matrix presence, which is per-user
  rather than per-room and stays active for 300s after the last sync, so it
  suppressed exactly the notification you were waiting for.
- The Matrix transport emits `dev.zooid.turn.end` at turn completion, carrying
  a preview of the agent's closing message so the notification can say what the
  agent said rather than only that it stopped.
- Agent prose is sent as `m.notice`, which the default
  `.m.rule.suppress_notices` rule silences — a verbose turn no longer fires one
  push per streamed chunk. Context assembly still reads it.
- `zooid dev` no longer hangs on shutdown. The context-MCP socket server now
  drops its connections on close; `net.Server.close()` waits for every open
  connection and, unlike `http.Server`, never drops idle ones, so it sat there
  until the agent's MCP child processes happened to exit. Tuwunel teardown is
  bounded, and a repeated Ctrl-C now escalates to a force quit.
