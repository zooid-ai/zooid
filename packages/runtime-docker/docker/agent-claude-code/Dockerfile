FROM ghcr.io/zooid-ai/agent-base:latest

# ZOD074: the ARG default is the pin. docker/versions.json maps this ARG to its
# npm package; image-versions.manifest.test.ts fails if the two disagree.
ARG CLAUDE_AGENT_ACP_VERSION=0.74.0
RUN npm install -g @agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION}

# No CMD — DockerAcpRuntime sets the entrypoint to the resolved ACP shim
# command (e.g. `npx @agentclientprotocol/claude-agent-acp`). The npm install
# above pre-populates the global cache so the first turn doesn't pay the
# `npx -y` download tax.
