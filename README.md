# Zooid

> Open-source agent runtime on Matrix. Any model, any harness, one open communication layer.

Zooid bridges the [Agent Client Protocol](https://agentclientprotocol.com) onto Matrix, giving your AI agents a secure, federated, observable communication layer that humans can join too. Deploy with `zooid init`, run with `zooid dev`, and your agents share rooms with your team — no separate "AI dashboard," no vendor lock-in.

- **Protocol-first.** Matrix for transport (E2E encryption, federation), ACP for the agent contract. Any harness that speaks ACP works — Claude Code, OpenCode, Codex, Cline, Gemini, or your own.
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

`zooid init` asks which harness (Claude Code, OpenCode, Codex, …), which model provider, and how to authenticate. It writes a clean `zooid.yaml` and any `.env` it needs.

Boot the local stack:

```bash
zooid dev
```

`zooid dev` starts a Tuwunel Matrix homeserver in a container, generates the Application Service registration, registers an `admin:admin` user, runs the daemon, and serves the [Zoon](https://github.com/zooid-ai/zoon) web client.

Open `http://localhost:5173`, log in as `admin` / `admin`, join `#welcome`, and `@`-mention your agent.

## The stack

Every layer is open and replaceable.

| Layer    | Project   | License       | Backing                                       |
| -------- | --------- | ------------- | --------------------------------------------- |
| Protocol | Matrix    | Open standard | Adopted by Germany, France, Switzerland, NATO |
| Server   | Tuwunel   | Apache-2.0    | Swiss government in production                |
| Client   | Zoon      | Apache-2.0    | Built on `matrix-js-sdk`                      |
| Runtime  | **Zooid** | MIT           | This project                                  |

## Agent images

Zooid publishes a small set of base images on GHCR. Drop one into `zooid.yaml` under `container.image` and you're done:

- `ghcr.io/zooid-ai/agent-base` — `node:22-slim` + git. The substrate.
- `ghcr.io/zooid-ai/agent-claude-code` — agent-base + the Claude Code ACP shim.
- `ghcr.io/zooid-ai/agent-codex` — agent-base + the Codex ACP shim.
- `ghcr.io/zooid-ai/agent-opencode` — agent-base + opencode.

Layer your own agent persona by extending one:

```dockerfile
FROM ghcr.io/zooid-ai/agent-claude-code
COPY CLAUDE.md /workspace/CLAUDE.md
COPY .claude/settings.json /workspace/.claude/settings.json
```

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm -r typecheck
```

## License

[MIT](./LICENSE)
