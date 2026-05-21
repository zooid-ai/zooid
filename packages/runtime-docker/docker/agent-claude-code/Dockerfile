FROM ghcr.io/zooid-ai/agent-base:latest

RUN npm install -g @agentclientprotocol/claude-agent-acp

# No CMD — DockerAcpRuntime sets the entrypoint to the resolved ACP shim
# command (e.g. `npx @agentclientprotocol/claude-agent-acp`). The npm install
# above pre-populates the global cache so the first turn doesn't pay the
# `npx -y` download tax.
