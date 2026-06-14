# 🪸 Zooid

> Open-source tool for defining and running AI agents alongside you and your team. Any model, any CLI.

Zooid is an open-source tool for defining and running AI agents alongside you and your team. It bridges [ACP](https://agentclientprotocol.com)-compatible agents (Claude Code, [opencode](https://opencode.ai), Codex, …) onto [Matrix](https://matrix.org) so your team and your agents share the same chat rooms — no separate "AI dashboard," no vendor lock-in. Deploy with `zooid init`, run with `zooid dev`.

**Full docs: [zooid.dev/docs](https://zooid.dev/docs)**

- **Protocol-first.** Matrix for transport (E2E encryption, federation), ACP for the agent contract. Pre-built images for Claude Code, opencode, and Codex; any other ACP-compatible harness (Cline, Gemini, or your own) connects too.
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

`zooid dev` starts a Tuwunel Matrix homeserver in a container, generates the Application Service registration, registers an `admin:admin` user, runs the daemon, and serves the [Zooid web client](https://github.com/zooid-ai/clients).

Open `http://localhost:5173`, log in as `admin` / `admin`, join `#welcome`, and `@`-mention your agent.

For deployment recipes, the `zooid.yaml` reference, and a deeper tour of how the runtime works, see **[zooid.dev/docs](https://zooid.dev/docs)**.

## The stack

Every layer is open and replaceable.

| Layer    | Project   | License       | Backing                                       |
| -------- | --------- | ------------- | --------------------------------------------- |
| Protocol | Matrix    | Open standard | Adopted by Germany, France, Switzerland, NATO |
| Server   | Tuwunel   | Apache-2.0    | Swiss government in production                |
| Client   | Zooid web | Apache-2.0    | Built on `matrix-js-sdk`                      |
| Runtime  | **Zooid** | MIT           | This project                                  |

## Agent images

Zooid publishes a small set of base images on GHCR. Drop one into `zooid.yaml` under `container.image` and you're done:

- `ghcr.io/zooid-ai/agent-base` — `node:22-slim` + git. The substrate.
- `ghcr.io/zooid-ai/agent-claude-code` — agent-base + the Claude Code ACP shim.
- `ghcr.io/zooid-ai/agent-codex` — agent-base + the Codex ACP shim.
- `ghcr.io/zooid-ai/agent-opencode` — agent-base + opencode.

The persona — `CLAUDE.md` / `AGENTS.md`, `.claude/settings.json`, skills, MCP servers — lives in the agent's `workdir` on the host. Zooid bind-mounts that directory into the container at runtime, so the shim picks it up the same way it would on your laptop. No `docker build`, no custom image, no rebuild when you tweak instructions.

## Contributing

Source and contribution guidelines: [github.com/zooid-ai/zooid](https://github.com/zooid-ai/zooid).

## License

[MIT](https://github.com/zooid-ai/zooid/blob/main/LICENSE)
