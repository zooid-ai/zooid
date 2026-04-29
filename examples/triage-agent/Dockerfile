# triage-agent — child image that layers agent instructions onto the base.
#
# Prerequisites:
#   Build the base image first (from the budd repo root):
#     docker build \
#       -f packages/runtime-docker/docker/claude/Dockerfile.local \
#       -t ghcr.io/zooid-ai/budd-agent-claude-code:local .
#
#   Then build this child image (from this directory):
#     docker build -t triage-agent:local .
#
# This image is used with DockerRuntime — the host budd spawns
# `claude` inside it via `--entrypoint claude`. The baked-in CLAUDE.md
# and .claude/settings.json give the agent its personality and
# permissions without needing them on the host.

FROM ghcr.io/zooid-ai/budd-agent-claude-code:local

# Agent personality and permissions
COPY CLAUDE.md /workspace/CLAUDE.md
COPY .claude/settings.json /workspace/.claude/settings.json

WORKDIR /workspace
