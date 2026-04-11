# zooid/agentd-claude — base image users `FROM` to ship a coding-agent endpoint.
#
# Bundles agentd + the Claude Code CLI on a Node 20 slim base. The user
# layers their own daemon.yaml + CLAUDE.md on top:
#
#   FROM zooid/agentd-claude
#   COPY daemon.yaml CLAUDE.md ./
#
# Inside this image both agentd and claude live in the same container, so
# daemon.yaml should set `runtime: local`.

FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG AGENTD_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest

RUN npm i -g \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@zooid/agentd@${AGENTD_VERSION}"

WORKDIR /workspace

EXPOSE 8080
ENTRYPOINT ["agentd"]

LABEL org.zooid.base="claude" \
      org.zooid.agent="base" \
      org.zooid.description="agentd + Claude Code CLI"
