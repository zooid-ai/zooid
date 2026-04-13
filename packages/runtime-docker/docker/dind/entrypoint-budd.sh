#!/bin/sh
set -eu

# Disable TLS — inner Docker is local-only, never exposed.
export DOCKER_TLS_CERTDIR=''

# Start rootless dockerd in background via the official entrypoint.
# The entrypoint eventually execs into rootlesskit → dockerd.
/usr/local/bin/dockerd-entrypoint.sh &

# Wait for Docker socket to appear.
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/docker.sock"

echo "[budd] waiting for rootless Docker daemon..."
timeout=30
while ! docker info >/dev/null 2>&1; do
  timeout=$((timeout - 1))
  if [ "$timeout" -le 0 ]; then
    echo "[budd] ERROR: Docker daemon failed to start within 30s" >&2
    exit 1
  fi
  sleep 1
done
echo "[budd] Docker daemon ready."

# Load pre-baked agent image tars if any exist.
for tar in /images/*.tar; do
  [ -f "$tar" ] || continue
  echo "[budd] loading image: $(basename "$tar")"
  docker load < "$tar"
done

echo "[budd] starting daemon..."
exec node /opt/budd/dist/bin.js "$@"
