# Smoke-test image for the opencode + Vertex Gemini reviewer agent.
#
# Bakes this agent's workspace at /workspace and installs opencode globally
# so the ACP shim is on PATH. Used by `runtime: docker` in the example's
# workforce.yaml.
#
# Build (from this directory):
#   docker build -t zooid-opencode-vertex:smoke .

FROM node:22-slim

# opencode-ai ships a glibc-linked Linux binary, so the base image needs glibc
# (node:22-slim is Debian, node:22-alpine is musl and won't load it).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g opencode-ai@1.14.41

WORKDIR /workspace
COPY . .
