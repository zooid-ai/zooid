FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# No CMD — DockerAcpRuntime always sets the entrypoint to the resolved
# ACP shim command at run time.
