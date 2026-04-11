# agentd

A small daemon that puts a CLI coding agent (Claude Code, Codex, …) behind an
HTTP API. You hand it a prompt; it spawns the agent against a workspace
directory and streams the agent's stdout back as Server-Sent Events.

Designed to be deployed as a container: `FROM zooid/agentd-claude`, layer in
your `daemon.yaml` and `CLAUDE.md`, push it anywhere that runs containers,
and you have an addressable agent endpoint.

## Why

Coding-agent CLIs are useful but awkward to operate. They expect a TTY, they
want to live next to a checkout, and they don't speak HTTP. agentd is the
thinnest thing that makes one of them look like a service:

- **HTTP in, SSE out.** `POST /run` with a prompt, get a stream of
  `session.started` → `stdout`/`stderr` → `session.ended` events.
- **Workspace-scoped.** Every run executes against a directory you control.
  The agent reads and writes the same filesystem.
- **Sandboxed by default.** The Docker runtime mounts only the configured
  workspace and forwards only an explicit allowlist of env vars. The host
  process never sees the agent's blast radius.
- **Adapter-shaped.** Today there's a Claude Code adapter; the same shape
  fits Codex, OpenCode, and friends.
- **Hooks.** `pre_start` and `post_end` shell commands run around each
  session — useful for `git pull` / `git push`, posting to Slack, opening
  a GitHub issue, etc.

## Quick start

The supported deployment is the prebuilt base image:

```bash
docker run --rm -p 8080:8080 \
  -e AGENTD_TOKEN=$(openssl rand -hex 32) \
  -e ANTHROPIC_API_KEY=sk-... \
  -v "$PWD:/workspace" \
  zooid/agentd-claude
```

Then, from another terminal:

```bash
curl -N -H "Authorization: Bearer $AGENTD_TOKEN" \
     -H "content-type: application/json" \
     -d '{"prompt":"add a CHANGELOG entry for the release"}' \
     http://localhost:8080/run
```

You'll see SSE frames like:

```
data: {"type":"session.started","session_id":"01JQXY..."}
data: {"type":"stdout","chunks":["{\"type\":\"assistant\",\"content\":\"Reading…\"}"]}
data: {"type":"session.ended","exit_code":0}
```

## Building your own image

The base image is meant to be extended:

```dockerfile
FROM zooid/agentd-claude

# Your agent's personality + scope
COPY CLAUDE.md /workspace/CLAUDE.md

# Optional: customise the daemon (hooks, port, runtime)
COPY daemon.yaml /workspace/daemon.yaml

WORKDIR /workspace
```

Push it to your registry, run it on Fly / Railway / Kubernetes / your laptop.
The endpoint is the same.

## `daemon.yaml`

Optional. Loaded from the current working directory if present. All fields
have defaults:

```yaml
transport: http              # only http in MVP
port: 8080
runtime: docker              # docker (default) or local
image: zooid/agentd-claude:latest   # only used when runtime: docker

hooks:
  pre_start: "git pull --rebase"
  post_end: "git push"
```

CLI flags (`--port`, `--runtime`, `--image`, `--workdir`, `--pre-start`,
`--post-end`) override the YAML.

## Runtimes

- **`docker`** *(default)* — agentd runs on the host, spawns the agent inside
  a container per session. Workspace is bind-mounted at `/workspace`. Only
  allowlisted env vars (`ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `SESSION_ID`,
  `MESSAGE_TEXT`, `WORKDIR`) are forwarded. Suitable for untrusted prompts
  and shared infrastructure.
- **`local`** — agentd spawns the agent directly on the host with the full
  process environment. Suitable for development and trusted single-user
  deploys. The base image uses this internally because agentd and the
  agent CLI live in the same container.

## Workspace layout

This is a pnpm monorepo:

```
packages/
├── core              # @zooid/agentd-core           — SessionRunner, config, types
├── adapter-claude    # @zooid/agentd-adapter-claude — Claude Code adapter
├── runtime-local     # @zooid/agentd-runtime-local  — host-process runtime
├── runtime-docker    # @zooid/agentd-runtime-docker — container runtime + base image
├── transport-http    # @zooid/agentd-transport-http — Hono server, bearer auth, SSE
├── cli               # @zooid/agentd                — `agentd` binary
└── homepage          # marketing site (separate workspace)
```

Architectural primitives:

- **`Runtime`** — knows how to spawn a process. `LocalRuntime`, `DockerRuntime`.
- **`AgentAdapter`** — knows how to invoke a specific CLI agent (build argv,
  detect availability, parse output).
- **`Transport`** — accepts inbound messages, returns outbound replies. The
  HTTP transport is the only one in MVP; Slack and Zooid pub/sub are planned.
- **`SessionRunner`** — the bit that ties them together. Spawn → chunk
  stdout/stderr → emit `SessionEvent`s → run hooks.

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test          # 73 unit tests across 6 packages
pnpm -r typecheck

# Docker e2e (slow — builds a stub image, hits a real Docker daemon)
pnpm -C packages/runtime-docker test:e2e
```

Run agentd from source against your current directory:

```bash
export AGENTD_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
node packages/cli/dist/bin.js --runtime local --port 8080
```

## Status

MVP. The HTTP transport, Claude adapter, local runtime, and Docker runtime
are wired up and tested. Slack and Zooid pub/sub transports, and Codex /
OpenCode adapters, are planned but not yet shipped.

## License

[MIT](./LICENSE)
