# budd/claude-code — inner agent image for the DinD runtime.
#
# Contains only the Claude Code CLI. This image is spawned per-session
# by the inner rootless dockerd inside budd/dind. budd sets the entrypoint
# via `docker run --entrypoint claude` and bind-mounts the workspace.
#
# It does NOT contain budd — for the single-container (runtime: local)
# image that bundles budd + claude, see docker/claude/Dockerfile instead.
#
# Build:
#   docker build \
#     -f packages/runtime-docker/docker/claude-agent/Dockerfile \
#     -t budd/claude-code:latest .
#
# daemon.yaml usage:
#   runtime: docker
#   docker:
#     image: budd/claude-code:latest

FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=latest
RUN npm i -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

WORKDIR /workspace

# budd overrides this with --entrypoint at `docker run` time. Declared here
# so the image is also usable standalone.
ENTRYPOINT ["claude"]

LABEL org.budd.role="agent" \
      org.budd.adapter="claude" \
      org.budd.description="Claude Code CLI — inner agent image for budd DinD runtime"
