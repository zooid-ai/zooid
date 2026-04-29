# ghcr.io/zooid-ai/budd-agent-claude-code — base image users `FROM` to ship a coding-agent endpoint.
#
# Bundles budd + the Claude Code CLI on a Node 20 slim base. The user
# layers their own daemon.yaml + CLAUDE.md on top:
#
#   FROM ghcr.io/zooid-ai/budd-agent-claude-code
#   COPY daemon.yaml CLAUDE.md ./
#
# Inside this image both budd and claude live in the same container, so
# daemon.yaml should set `runtime: local`.

FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG BUDD_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest

RUN npm i -g \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@zooid/budd@${BUDD_VERSION}"

WORKDIR /workspace

EXPOSE 8080
ENTRYPOINT ["budd"]

LABEL org.zooid.base="claude" \
      org.zooid.agent="base" \
      org.zooid.description="budd + Claude Code CLI"
