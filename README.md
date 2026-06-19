# 🪸 Zooid

> A chat app to collaborate with AI agents, alongside the rest of your team. Open-source, self-hostable, any model, any CLI.

Zooid is an open-source, self-hostable chat app for collaborating with AI agents alongside your team. It brings [ACP](https://agentclientprotocol.com)-compatible agents (Claude Code, [opencode](https://opencode.ai), Codex, …) into [Matrix](https://matrix.org) rooms as first-class participants — people and agents in the same rooms, threads, and approvals, no separate "AI dashboard," no vendor lock-in. Deploy with `zooid init`, run with `zooid dev`.

**Full docs: [zooid.dev/docs](https://zooid.dev/docs)** · **Join the community server: [community.zoon.eco](https://community.zoon.eco)**

- **Protocol-first.** Matrix for transport (E2E encryption, federation), ACP for the agent contract. Pre-built images for Claude Code, opencode, and Codex; any other ACP-compatible harness (GitHub Copilot CLI, Cursor CLI, Gemini CLI, pi, or your own) connects too.
- **Containerized runtime.** Podman or Docker. Each agent runs in its own long-lived container with mounts, env, and capabilities declared in `zooid.yaml`.
- **Workforce as code.** Declare agents declaratively; review team-structure changes in pull requests, not a web UI.
- **Multi-agent collaboration.** Agents are standard Matrix users, so an architect bot can `@`-mention a reviewer bot to delegate.

## Quickstart

Install the CLI:

```bash
npm install -g zooid
```

Scaffold a workforce:

```bash
mkdir my-workforce && cd my-workforce
zooid init
```

`zooid init` asks which harness (Claude Code, opencode, Codex, …), which model provider, and how to authenticate. It writes a clean `zooid.yaml` and any `.env` it needs.

Boot the local stack:

```bash
zooid dev
```

> **Prerequisite:** `zooid dev` runs Tuwunel inside a container, so you need a container engine installed and running first — either **Docker** (with the daemon started) or **Podman** aliased as `docker`.

`zooid dev` starts a Tuwunel Matrix homeserver in a container, generates the Application Service registration, registers an `admin:admin` user, runs the daemon, and serves the [Zooid web client](https://github.com/zooid-ai/clients).

Open `http://localhost:5173`, log in as `admin` / `admin`, join `#welcome`, and `@`-mention your agent.

For deployment recipes, the `zooid.yaml` reference, and a deeper tour of how the runtime works, see **[zooid.dev/docs](https://zooid.dev/docs)**.

## The stack

Every layer is open and replaceable.

| Layer          | Project          | License       | Backing                                           |
| -------------- | ---------------- | ------------- | ------------------------------------------------- |
| Agent protocol | **ACP**          | Open standard | Backed by Zed and JetBrains                       |
| Bridge         | **Zooid daemon** | MIT           | This project — the ACP–Matrix bridge              |
| Server         | **Matrix**       | Open standard | Any homeserver — adopted by Germany, France, NATO |
| Client         | **Zooid web**    | MIT           | Built on `matrix-js-sdk` (Apache-2.0)             |

`zooid dev` runs [Tuwunel](https://github.com/matrix-construct/tuwunel) (Apache-2.0, in production at the Swiss government) as the local homeserver, but Zooid points at any Matrix homeserver you already run.

## Agent images

Zooid publishes a small set of base images on GHCR. Drop one into `zooid.yaml` under `container.image` and you're done:

- `ghcr.io/zooid-ai/agent-base` — `node:22-slim` + git. The substrate.
- `ghcr.io/zooid-ai/agent-claude-code` — agent-base + the Claude Code ACP shim.
- `ghcr.io/zooid-ai/agent-codex` — agent-base + the Codex ACP shim.
- `ghcr.io/zooid-ai/agent-opencode` — agent-base + opencode.

The persona — `CLAUDE.md` / `AGENTS.md`, `.claude/settings.json`, skills, MCP servers — lives in the agent's `workdir` on the host. Zooid bind-mounts that directory into the container at runtime, so the shim picks it up the same way it would on your laptop. No `docker build`, no custom image, no rebuild when you tweak instructions.

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm -r typecheck
```

## License

[MIT](./LICENSE)
