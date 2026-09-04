FROM ghcr.io/zooid-ai/agent-base:latest

# ZOD074: the ARG default is the pin. docker/versions.json maps this ARG to its
# npm package; image-versions.manifest.test.ts fails if the two disagree.
ARG OPENCODE_VERSION=1.18.27
RUN npm install -g opencode-ai@${OPENCODE_VERSION}
