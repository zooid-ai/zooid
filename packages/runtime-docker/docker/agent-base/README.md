# zooid-agent-base

Container base image for `DockerAcpRuntime`. Contains node 22, git, and
CA certificates — nothing else. Each agent's ACP shim is invoked via
`docker run --entrypoint <shim-command>`, so the image itself does not
hard-code which CLI it hosts.

Build locally:

```sh
docker build -t ghcr.io/zooid-ai/zooid-agent-base:local \
  -f packages/runtime-docker/docker/agent-base/Dockerfile \
  packages/runtime-docker/docker/agent-base
```

Set as the runtime default in `workforce.yaml`:

```yaml
transport: http
runtime: docker
docker:
  image: ghcr.io/zooid-ai/zooid-agent-base:local
```

Per-agent overrides are still possible via `agents.<name>.docker.image`.
