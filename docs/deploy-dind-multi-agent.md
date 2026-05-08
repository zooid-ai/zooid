# Deploy a multi-agent budd daemon with DinD on EC2 / Fly.io

This guide walks through running a **single budd daemon that hosts multiple
agents** — e.g. a Claude persona and a Codex persona under one HTTP API —
using the `ghcr.io/zooid-ai/budd-runtime-dind` image. The daemon runs budd + a rootless Docker
daemon in the same container; each incoming session gets its own
short-lived agent container spawned by the inner dockerd.

When you want this:

- **Mixed adapters.** One daemon serving `/agents/qa` (Claude) and
  `/agents/ship` (Codex) so the agents can talk to each other through
  your own message bus without N deployments.
- **Per-session sandboxing.** Each turn runs in a fresh container, so
  a malicious prompt can't read the daemon's filesystem or secrets.
- **Untrusted workspaces.** The workspace is bind-mounted RW, but each
  adapter declares read-only carveouts (`CLAUDE.md`, `.claude`, etc.)
  that the agent cannot overwrite on the host.

If you only have one agent and don't need sandboxing, use
[deploy-ec2-docker-compose.md](deploy-ec2-docker-compose.md) instead — it's
simpler and cheaper.

## What you'll build

```
┌─────────────────────────────── EC2 / Fly VM ───────────────────────────┐
│                                                                         │
│  ┌────────── ghcr.io/zooid-ai/budd-runtime-dind container ─────────────────────────────────────┐ │
│  │                                                                    │ │
│  │  [rootless dockerd]  ──pulls──►  [ghcr.io/zooid-ai/budd-agent-claude-code:latest (Docker Hub)]│ │
│  │                      ──pulls──►  [ghcr.io/zooid-ai/budd-agent-codex:latest   (Docker Hub)]│ │
│  │                      ──spawns─►  [qa session]                      │ │
│  │                      ──spawns─►  [ship session]                    │ │
│  │                                                                    │ │
│  │  [budd daemon on :8080]                                            │ │
│  │       ▲                                                            │ │
│  │       │ /agents/qa/sessions, /agents/ship/sessions                 │ │
│  └───────┼────────────────────────────────────────────────────────────┘ │
│          │                                                              │
│  ┌───────┴──────── Caddy (auto-HTTPS) ──────────────────────────────┐  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

Key idea: **agent personas are files on the host, not custom Docker images.**
The inner dockerd pulls stock public adapter images (`ghcr.io/zooid-ai/budd-agent-claude-code`,
`ghcr.io/zooid-ai/budd-agent-codex`) once per VM, and budd bind-mounts your persona files into each
session via the adapter's built-in read-only carveouts. Updating a persona
is a file edit, not a rebuild.

## Prerequisites

- Anthropic API key and/or Codex API key
- A domain name pointed at your VM (for auto-TLS)
- Docker installed locally (for testing and building the DinD image)

---

## 1. Lay out your agents

A deploy directory with one subdirectory per agent. Each agent is just
files — a persona doc, a permissions file, maybe a shared docs directory.
No Dockerfiles.

```
deploy/
├── zooid.yaml
├── docker-compose.yml     # for EC2
├── fly.toml               # for Fly.io
├── Caddyfile              # EC2 only — Fly terminates HTTPS at the edge
└── agents/
    ├── qa/
    │   ├── CLAUDE.md               # persona / instructions
    │   └── .claude/
    │       └── settings.json       # tool allow/deny permissions
    └── ship/
        ├── AGENTS.md               # Codex persona
        └── .codex/
            └── config.toml         # Codex config
```

**`deploy/zooid.yaml`:**

```yaml
transport: http
runtime: docker
port: 8080

agents:
  qa:
    workdir: ./agents/qa
    adapter: claude
    docker:
      image: ghcr.io/zooid-ai/budd-agent-claude-code:latest  # public image on Docker Hub
      # Optional: forward extra vars from the daemon's environment.
      # ANTHROPIC_API_KEY is forwarded automatically by the claude adapter.
      # forward_env:
      #   - JIRA_URL

  ship:
    workdir: ./agents/ship
    adapter: codex
    docker:
      image: ghcr.io/zooid-ai/budd-agent-codex:latest     # public image on Docker Hub
      mounts:
        extra:
          # Example: share a RO docs directory into every ship session
          - path: ./shared-docs
            target: /workspace/docs
            mode: ro
```

What happens at session time:

1. budd reads `agents.qa.workdir` (`./agents/qa`) and uses it as the session's RW workspace.
2. The Claude adapter declares `CLAUDE.md` and `.claude/` as RO carveouts — budd mounts them RO on top of the RW workspace, so the agent can read its persona but not rewrite it.
3. The Codex adapter does the same with `AGENTS.md` and `.codex/`.
4. Session state (`~/.claude/projects/-workspace/<id>.jsonl`) is persisted to a host volume so resume works across container restarts.

No per-agent image build, no tarballs.

---

## 2. The DinD image

Use the published image from Docker Hub:

```
ghcr.io/zooid-ai/budd-runtime-dind:latest
```

It bundles budd + rootless dockerd + the supported adapter CLIs
(`claude-code`, `codex`). You don't need to build anything — compose and
Fly will pull it directly.

Pin a specific version in production (`ghcr.io/zooid-ai/budd-runtime-dind:0.3.0` rather than
`:latest`) so `docker compose pull` / `flyctl deploy` don't silently
upgrade you.

The first time a DinD container runs, its inner rootless dockerd pulls
`ghcr.io/zooid-ai/budd-agent-claude-code:latest` and `ghcr.io/zooid-ai/budd-agent-codex:latest` from Docker Hub. Subsequent
sessions reuse the cache (see §4.4 and §5.2 for the volume that makes
this cache survive container restarts).

> **Building your own:** if you need to pin adapter CLI versions or add
> adapters not yet in the official image, see [§8. Building a custom
> DinD image](#8-building-a-custom-dind-image) below.

---

## 3. Test locally

```bash
export BUDD_TOKEN=$(openssl rand -hex 32)
export ANTHROPIC_API_KEY=sk-ant-...
export CODEX_API_KEY=...

# On Mac (Docker Desktop) — needs --privileged because the Docker Desktop
# VM is locked down. On a Linux host, drop --privileged; rootless dockerd
# works with ordinary user namespaces.
docker run -d --rm --name budd-test -p 8080:8080 \
  --privileged \
  -e BUDD_TOKEN \
  -e ANTHROPIC_API_KEY \
  -e CODEX_API_KEY \
  -v "$(pwd)/deploy:/workspace" \
  ghcr.io/zooid-ai/budd-runtime-dind:latest

docker logs -f budd-test       # wait for "budd listening"
```

Hit both agents:

```bash
# QA persona (Claude)
curl -N -H "Authorization: Bearer $BUDD_TOKEN" \
     -H "content-type: application/json" \
     -d '{"prompt":"review the auth middleware for security issues"}' \
     http://localhost:8080/agents/qa/sessions

# Ship persona (Codex)
curl -N -H "Authorization: Bearer $BUDD_TOKEN" \
     -H "content-type: application/json" \
     -d '{"prompt":"write a CHANGELOG entry for the last five commits"}' \
     http://localhost:8080/agents/ship/sessions
```

---

## 4. Deploy to EC2

EC2 is the most forgiving target: Linux kernel, user namespaces enabled
by default on Amazon Linux 2023 and Ubuntu 24.04, no request timeouts.
The DinD image runs **unprivileged** on a real Linux host.

### 4.1. Launch an instance

- **AMI:** Amazon Linux 2023 or Ubuntu 24.04
- **Instance type:** `t3.large` minimum (2 vCPU, 8 GB). Budget ~2 GB per concurrent session.
- **Security group:** inbound 22 (SSH), 80, 443
- **Storage:** 40 GB gp3 — the DinD image is ~1 GB, adapter images pulled on first run add ~2 GB total.

Install Docker following the steps in
[deploy-ec2-docker-compose.md](deploy-ec2-docker-compose.md) §3–§5.

### 4.2. Ship your personas to the instance

Simplest option — `scp` the whole `deploy/` directory:

```bash
# From your laptop
scp -r -i your-key.pem deploy/ ec2-user@<instance-ip>:~/deploy/
```

Other options, in rough order of sophistication:

- Keep personas in git; `git clone` / `git pull` on the instance. Good for teams with multiple people editing prompts.
- Sync from S3: `aws s3 sync s3://myorg-agents/ ~/deploy/agents/`. Good for IAM-role-based access.

Pick whichever matches how your team already ships config. All three end
up with the same file layout under `~/deploy/`.

### 4.3. Compose stack

On the EC2 instance, at `~/deploy/docker-compose.yml`:

```yaml
services:
  budd:
    image: ghcr.io/zooid-ai/budd-runtime-dind:latest
    restart: unless-stopped
    # No `privileged: true` on Linux — rootless dockerd works with plain
    # user namespaces.
    command: ["--runtime", "docker"]
    environment:
      BUDD_TOKEN: ${BUDD_TOKEN}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      CODEX_API_KEY: ${CODEX_API_KEY}
    volumes:
      - ./:/workspace                                          # zooid.yaml + agents/ live here
      - budd-sessions:/home/rootless/.claude                   # Claude session state
      - budd-sessions-codex:/home/rootless/.codex              # Codex session state
      - budd-inner-docker:/home/rootless/.local/share/docker   # cache pulled adapter images
    expose:
      - "8080"

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config

volumes:
  budd-sessions:
  budd-sessions-codex:
  budd-inner-docker:
  caddy-data:
  caddy-config:
```

**`Caddyfile`:**

```
agents.yourdomain.com {
    reverse_proxy budd:8080
}
```

### 4.4. Start it

```bash
# ~/deploy/.env
cat > .env <<EOF
BUDD_TOKEN=$(openssl rand -hex 32)
ANTHROPIC_API_KEY=sk-ant-...
CODEX_API_KEY=...
EOF

docker compose up -d
docker compose logs -f budd
```

First boot takes a minute while the inner dockerd pulls `ghcr.io/zooid-ai/budd-agent-claude-code` and
`ghcr.io/zooid-ai/budd-agent-codex` from Docker Hub. Subsequent boots reuse the `budd-inner-docker`
volume cache and start in seconds.

Hit it:

```bash
curl -N -H "Authorization: Bearer $BUDD_TOKEN" \
     -H "content-type: application/json" \
     -d '{"prompt":"…"}' \
     https://agents.yourdomain.com/agents/qa/sessions
```

---

## 5. Deploy to Fly.io

Fly's machines are Linux VMs, so rootless DinD runs unprivileged. Fly
terminates HTTPS at the edge (no Caddy needed), and its `[[files]]`
mechanism ships your persona files as part of `flyctl deploy` — simpler
than `scp`.

### 5.1. Create the app

```bash
flyctl auth login
flyctl apps create budd-agents
```

### 5.2. `fly.toml`

Point Fly at the public DinD image and use `[[files]]` blocks to ship
persona files into the machine's filesystem at deploy time:

```toml
app = "budd-agents"
primary_region = "iad"

[build]
  image = "ghcr.io/zooid-ai/budd-runtime-dind:latest"

[processes]
  app = "--runtime docker"

[[services]]
  protocol = "tcp"
  internal_port = 8080

  [[services.ports]]
    port = 80
    handlers = ["http"]
    force_https = true

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

[[vm]]
  cpu_kind = "shared"
  cpus = 2
  memory_mb = 4096              # bump to 8192+ for >1 concurrent session

[[mounts]]
  source = "budd_data"
  destination = "/home/rootless"   # persists both session state AND the inner-docker image cache

# Agent personas as [[files]]. flyctl re-uploads these on every deploy.
[[files]]
  guest_path = "/workspace/zooid.yaml"
  local_path = "./zooid.yaml"

[[files]]
  guest_path = "/workspace/agents/qa/CLAUDE.md"
  local_path = "./agents/qa/CLAUDE.md"

[[files]]
  guest_path = "/workspace/agents/qa/.claude/settings.json"
  local_path = "./agents/qa/.claude/settings.json"

[[files]]
  guest_path = "/workspace/agents/ship/AGENTS.md"
  local_path = "./agents/ship/AGENTS.md"

[[files]]
  guest_path = "/workspace/agents/ship/.codex/config.toml"
  local_path = "./agents/ship/.codex/config.toml"
```

### 5.3. Secrets, volume, deploy

```bash
flyctl secrets set \
  BUDD_TOKEN=$(openssl rand -hex 32) \
  ANTHROPIC_API_KEY=sk-ant-... \
  CODEX_API_KEY=...

flyctl volumes create budd_data --size 10 --region iad
flyctl deploy
```

### 5.4. Auto-stop

Fly stops idle machines by default. Set `auto_stop_machines = false` in
the `[[services]]` block if you need long-lived SSE streams — a 5-minute
idle can otherwise terminate a session mid-turn. If auto-stop is
tolerable, sessions resume fine because state lives on the volume.

---

## 6. Updating personas

The whole point of this layout: updates are file edits, not rebuilds.

**EC2:**

```bash
# Edit locally, then
scp -i your-key.pem agents/qa/CLAUDE.md ec2-user@<ip>:~/deploy/agents/qa/
```

New sessions pick up the updated persona immediately. In-flight sessions
continue with their mounted snapshot (that's a feature — no mid-turn
surprises).

**Fly:**

```bash
# Edit locally, then
flyctl deploy
```

`flyctl deploy` re-uploads every `[[files]]` block. Same in-flight
semantics as above.

---

## 7. Operational notes

### Secrets inside inner containers

budd forwards env vars into each agent container in two layers:

1. **Adapter-declared** — each adapter lists the vars its CLI needs
   (`claudeAdapter` declares `ANTHROPIC_API_KEY`; `codexAdapter` declares
   `CODEX_API_KEY`). These are forwarded automatically if present in the
   daemon's environment.

2. **User-declared** — add one-off vars per agent in `zooid.yaml`:

   ```yaml
   agents:
     qa:
       docker:
         forward_env:
           - JIRA_URL                   # pass-through same-name
           - CORP_ANTHROPIC_KEY:ANTHROPIC_API_KEY   # rename HOST→CONTAINER
   ```

**`BUDD_TOKEN` and any `BUDD_*` variable are blocked unconditionally** —
they never reach an agent container regardless of what appears in
`forward_env`. Per-turn runtime vars (`SESSION_ID`, `MESSAGE_TEXT`,
`WORKDIR`) are injected by the runner and bypass this list.

### Read-only carveouts are per-adapter

Claude sessions mount `CLAUDE.md` and `.claude` RO on top of the RW
workspace. Codex mounts `AGENTS.md` and `.codex`. The agent can still
write elsewhere in `/workspace`. To make specific files writable (e.g.
you want the agent to be able to update its own `CLAUDE.md`), use:

```yaml
agents:
  qa:
    docker:
      mounts:
        workspace_readonly_disable: [CLAUDE.md]
```

### Observability

```bash
docker compose logs budd       # EC2
flyctl logs                    # Fly
```

### Stopping runaway sessions

budd has no per-session CPU/memory quotas yet. Set a hard VM-level
memory limit and have a supervisor poll session event streams for
activity. To kill all in-flight sessions, `docker restart` the DinD
container — there's no graceful-kill endpoint yet.

### Costs

| | EC2 (`t3.large`, Elastic IP, 40 GB gp3) | Fly.io (shared-2x, 4 GB, 10 GB vol) |
|---|---|---|
| Always-on | ~$65/mo | ~$25/mo |
| Auto-stop (idle) | — | ~$5/mo + per-hour burst |
| HTTPS | Caddy + Let's Encrypt (free) | built-in |
| DinD mode | unprivileged (rootless) | unprivileged (rootless) |
| SSE friendliness | no timeouts | auto-stop hazard — see §5.4 |

EC2 wins for unpredictable traffic and long sessions. Fly wins on cost
and simpler deploys for bursty or bounded-duration workloads.

---

## Troubleshooting

**`docker run -v CLAUDE.md:... source is not directory`**

`workdir` in zooid.yaml was relative and couldn't be resolved. Use an
absolute `workdir`, or make sure budd sees the zooid.yaml's parent
directory as its `configDir` (the CLI handles this automatically when
it loads `./zooid.yaml` from the cwd).

**Inner dockerd fails with `iptables not available` or `unshare: EPERM`**

Your host kernel doesn't have user namespaces enabled, or your container
runtime is rejecting the syscalls rootless dockerd needs. On Linux
hosts with an unusual security profile, fall back to `--privileged`
(EC2) or the `privileged = true` experimental flag (Fly). On Mac's
Docker Desktop, `--privileged` is the norm for local testing.

**Sessions don't resume after restart**

The session-state volume must be mounted at the container's HOME
(`/home/rootless/.claude`, `/home/rootless/.codex`). The DinD image runs
as the `rootless` user, not root.

**Cold starts are slow**

The first boot pulls adapter images over the network. Mount a named
volume at `/home/rootless/.local/share/docker` so the image cache
persists across container restarts (see §4.4 and §5.2 for the exact
mount).

---

## 8. Building a custom DinD image

Use this path if you need to pin adapter CLI versions, add an adapter
not yet in the official image, or bake in site-specific tooling. For the
common case, stick with `ghcr.io/zooid-ai/budd-runtime-dind:latest` — nothing below is required
to deploy.

```bash
git clone https://github.com/zooid/budd.git
cd budd

docker build \
  --build-arg CLAUDE_CODE_VERSION=2.1.101 \
  -f packages/runtime-docker/docker/dind/Dockerfile.local \
  -t myorg/budd-dind:0.3.0 .

docker push myorg/budd-dind:0.3.0
```

Then reference your tag wherever the guide above uses `ghcr.io/zooid-ai/budd-runtime-dind:latest`:

- **EC2 compose:** `image: myorg/budd-dind:0.3.0`
- **Fly:** `[build] image = "docker.io/myorg/budd-dind:0.3.0"`

The Dockerfile accepts `CLAUDE_CODE_VERSION` and `CODEX_VERSION`
build-args for pinning adapter CLIs. To add a new adapter, extend the
install step and register it in budd before rebuilding.
