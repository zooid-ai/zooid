# budd

A small daemon that puts a CLI coding agent (Claude Code, Codex, …) behind an
HTTP API. You hand it a prompt; it spawns the agent against a workspace
directory and streams the agent's stdout back as Server-Sent Events.

Designed to be deployed as a container: `FROM budd/claude-code`, layer in
your `daemon.yaml` and `CLAUDE.md`, push it anywhere that runs containers,
and you have an addressable agent endpoint.

## Why

Coding-agent CLIs are useful but awkward to operate. They expect a TTY, they
want to live next to a checkout, and they don't speak HTTP. budd is the
thinnest thing that makes one of them look like a service:

- **HTTP in, SSE out.** `POST /sessions` with a prompt, get a stream of
  `session.start` → `turn.start` → `stdout`/`stderr` → `turn.end` events.
  Resume with `POST /sessions/:id/turns`. Reattach a disconnected client
  with `GET /sessions/:id/events`.
- **Workspace-scoped.** Every run executes against a directory you control.
  The agent reads and writes the same filesystem.
- **Sandboxed by default.** The Docker runtime mounts only the configured
  workspace and forwards only an explicit allowlist of env vars. The host
  process never sees the agent's blast radius.
- **Adapter-shaped.** Today there's a Claude Code adapter; the same shape
  fits Codex, OpenCode, and friends.
- **Hooks.** `pre_turn` and `post_turn` shell commands run around each
  turn — useful for `git pull` / `git push`, posting to Slack, opening
  a GitHub issue, etc.

## Quick start

The supported deployment is the prebuilt base image:

```bash
docker run --rm -p 8080:8080 \
  -e BUDD_TOKEN=$(openssl rand -hex 32) \
  -e ANTHROPIC_API_KEY=sk-... \
  -v "$PWD:/workspace" \
  budd/claude-code
```

Then, from another terminal:

```bash
curl -N -H "Authorization: Bearer $BUDD_TOKEN" \
     -H "content-type: application/json" \
     -d '{"prompt":"add a CHANGELOG entry for the release"}' \
     http://localhost:8080/sessions
```

To resume an existing session, post a turn against its id (extracted from
the `session.start` event of the original response):

```bash
curl -N -H "Authorization: Bearer $BUDD_TOKEN" \
     -H "content-type: application/json" \
     -d '{"prompt":"also add a release date"}' \
     http://localhost:8080/sessions/$SESSION_ID/turns
```

To reattach to an in-flight session (or read its history), tail its event
stream — replicas behind a load balancer all read from the same shared
storage backing the adapter, so reattach works across instances:

```bash
curl -N -H "Authorization: Bearer $BUDD_TOKEN" \
     http://localhost:8080/sessions/$SESSION_ID/events
```

You'll see SSE frames like:

```
data: {"type":"session.start","session_id":"01JQXY..."}
data: {"type":"turn.start"}
data: {"type":"stdout","chunks":["{\"type\":\"assistant\",\"content\":\"Reading…\"}"]}
data: {"type":"turn.end","exit_code":0}
```

## Building your own image

The base image is meant to be extended:

```dockerfile
FROM budd/claude-code

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

docker:                      # ignored when runtime: local
  image: budd/claude-code:latest
  home_mounts:               # optional — override adapter defaults
    - path: .claude/settings.json
      mode: ro
    - path: .claude/projects
      mode: rw
    - path: .claude/memory
      mode: rw

hooks:
  pre_turn: "git pull --rebase"
  post_turn: "git push"
```

CLI flags (`--port`, `--runtime`, `--image`, `--workdir`, `--pre-turn`,
`--post-turn`) override the YAML.

## Runtimes

- **`docker`** *(default)* — budd runs on the host, spawns the agent inside
  a container per session. Workspace is bind-mounted at `/workspace`. Only
  allowlisted env vars (`ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `SESSION_ID`,
  `MESSAGE_TEXT`, `WORKDIR`) are forwarded. Agent home directories (e.g.
  `~/.claude/projects`, `~/.claude/memory`) are mounted from the host so
  session state persists across container runs. Each adapter declares its
  default mounts; override them via `docker.home_mounts` in daemon.yaml.
  Suitable for untrusted prompts and shared infrastructure.
- **`local`** — budd spawns the agent directly on the host with the full
  process environment. Suitable for development and trusted single-user
  deploys. The base image uses this internally because budd and the
  agent CLI live in the same container.

## Workspace layout

This is a pnpm monorepo:

```
packages/
├── core              # @zooid/budd-core           — SessionRunner, config, types
├── adapter-claude    # @zooid/budd-adapter-claude — Claude Code adapter
├── runtime-local     # @zooid/budd-runtime-local  — host-process runtime
├── runtime-docker    # @zooid/budd-runtime-docker — container runtime + base image
├── transport-http    # @zooid/budd-transport-http — Hono server, bearer auth, SSE
├── cli               # @zooid/budd                — `budd` binary (npm)
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

## Deploying to the cloud (Docker-in-Docker)

For cloud deployment (Fly.io, AWS ECS, etc.) budd runs as a rootless
Docker-in-Docker container: an outer container hosts the budd daemon and a
nested Docker daemon, and each agent session spawns inside an inner container.
Your agent image is pre-baked into the outer image so no registry pull happens
at runtime.

### 1. Write your agent

```
examples/triage-agent/
├── CLAUDE.md                    # Agent personality & instructions
├── .claude/settings.json        # Tool permissions
├── daemon.yaml                  # Optional: hooks, port
└── Dockerfile                   # Agent image definition
```

The Dockerfile is minimal — just layer your instructions onto the base:

```dockerfile
FROM budd/claude-code:local
COPY CLAUDE.md /workspace/CLAUDE.md
COPY .claude/settings.json /workspace/.claude/settings.json
WORKDIR /workspace
```

### 2. Build the agent image

```bash
# From the budd repo root — build the base image
docker build \
  -f packages/runtime-docker/docker/claude/Dockerfile.local \
  -t budd/claude-code:local .

# From the agent directory — build the child image
cd examples/triage-agent
docker build -t triage-agent:local .
```

### 3. Save the agent image as a tar

```bash
# Back in the budd repo root
mkdir -p images
docker save triage-agent:local -o images/triage-agent.tar
```

This tar gets baked into the DinD image so the inner Docker daemon has it at
startup — no registry pull needed.

### 4. Build the DinD image

```bash
docker build \
  -f packages/runtime-docker/docker/dind/Dockerfile.local \
  -t budd/dind:triage-agent .
```

This produces a single image that contains:
- Rootless Docker daemon (no `--privileged` needed on Linux hosts)
- Node.js + budd + Claude Code CLI
- Your `triage-agent:local` image pre-loaded

### 5. Deploy

**Fly.io:**

```toml
# fly.toml
app = "triage-agent"

[build]
  image = "budd/dind:triage-agent"

[env]
  # Use `fly secrets set` for these instead of plain env:
  # BUDD_TOKEN, ANTHROPIC_API_KEY

[[services]]
  internal_port = 8080
```

```bash
fly deploy
```

**AWS EC2 + Docker Compose + Caddy** (recommended):

A single EC2 instance with Docker Compose and Caddy for auto-TLS. No
timeout limits, DinD-ready if you need sandboxing later, full SSH access.
See **[docs/deploy-ec2-docker-compose.md](docs/deploy-ec2-docker-compose.md)**.

**AWS App Runner** (serverless alternative):

Simpler managed option — no instance to maintain, auto-scales to zero. But
has a 120s request timeout (problematic for long agent turns) and no DinD
support. See **[docs/deploy-aws-app-runner.md](docs/deploy-aws-app-runner.md)**.

**AWS ECS / Fly.io / bare VM (DinD — sandboxed):**

The DinD image uses rootless Docker, so `--privileged` is **not** required
on Linux hosts. It does need a runtime that allows user namespaces (nested
container creation). ECS on EC2, Fly Machines, and bare VMs all work.

```bash
# Push to ECR
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
docker tag budd/dind:triage-agent <account>.dkr.ecr.<region>.amazonaws.com/budd-triage:latest
docker push <account>.dkr.ecr.<region>.amazonaws.com/budd-triage:latest
```

> **Note:** Fargate, App Runner, and Cloud Run restrict namespace creation,
> so rootless DinD won't work there. Use the local-runtime single-container
> approach instead (see the App Runner guide above).

### 6. Hit it

```bash
curl -N -H "Authorization: Bearer $BUDD_TOKEN" \
     -H "content-type: application/json" \
     -d '{"prompt":"the get started button is too small on mobile"}' \
     https://triage-agent.fly.dev/sessions
```

### The complete picture

```
Your machine                          Cloud (Fly/AWS)
─────────────                         ───────────────
CLAUDE.md ─┐
settings ──┤ docker build             budd/dind:triage-agent
           ├──────────────► tar ──►   ├─ rootless dockerd
           │                          ├─ budd --runtime docker
           │                          ├─ triage-agent:local (pre-loaded)
           │                          └─ claude (spawned per session)
```

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test          # 73 unit tests across 6 packages
pnpm -r typecheck

# Docker e2e (slow — builds a stub image, hits a real Docker daemon)
pnpm -C packages/runtime-docker test:e2e
```

Run budd from source against your current directory:

```bash
export BUDD_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
node packages/cli/dist/bin.js --runtime local --port 8080
```

## Status

MVP. The HTTP transport, Claude adapter, local runtime, and Docker runtime
are wired up and tested. Slack and Zooid pub/sub transports, and Codex /
OpenCode adapters, are planned but not yet shipped.

## License

[MIT](./LICENSE)
