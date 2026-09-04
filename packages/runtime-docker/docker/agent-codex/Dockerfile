FROM ghcr.io/zooid-ai/agent-base:latest

# ZOD074: the ARG default is the pin. docker/versions.json maps this ARG to its
# npm package; image-versions.manifest.test.ts fails if the two disagree.
ARG CODEX_ACP_VERSION=0.16.0
RUN npm install -g @zed-industries/codex-acp@${CODEX_ACP_VERSION}
