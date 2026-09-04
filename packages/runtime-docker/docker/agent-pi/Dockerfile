FROM ghcr.io/zooid-ai/agent-base:latest

# pi-acp is an adapter: it spawns `pi --mode rpc` as a child process, so BOTH
# packages must be on PATH. Installing only pi-acp yields an image that starts,
# completes the ACP handshake, and then fails on the first turn.
#
# ZOD073 pins these inline, unlike the three older agent images, which install
# unpinned and therefore freeze at whatever was current when someone last ran
# the publish workflow by hand. [[ZOD074]] hoists all four into
# docker/versions.json and automates the refresh.
ARG PI_VERSION=0.85.0
ARG PI_ACP_VERSION=0.0.33
RUN npm install -g \
      @earendil-works/pi-coding-agent@${PI_VERSION} \
      pi-acp@${PI_ACP_VERSION}

# No CMD — DockerAcpRuntime sets the entrypoint to the resolved ACP shim command.
