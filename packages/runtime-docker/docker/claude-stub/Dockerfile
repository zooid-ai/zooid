# Test-only stub image for the budd Docker runtime e2e suite.
#
# Provides a tiny `/usr/local/bin/claude` script that mimics
# `claude --output-format stream-json`. The host runs budd with
# --runtime docker --image budd/claude-code-stub:test, and the
# container exec'd by docker run is just this script.
#
# Built locally by tests/e2e/docker.e2e.test.ts; never published.

# debian:bookworm-slim because the e2e environment may not have outbound
# Docker Hub access. Any tiny base with a POSIX `sh` works — the stub
# script only uses standard sh built-ins.
FROM debian:bookworm-slim

COPY claude /usr/local/bin/claude
RUN chmod +x /usr/local/bin/claude

WORKDIR /workspace
