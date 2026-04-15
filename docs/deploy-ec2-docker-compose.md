# Deploy budd to EC2 with Docker Compose + Caddy

A single EC2 instance running Docker Compose: budd for the agent, Caddy for
automatic HTTPS. This is the recommended AWS deployment for budd because:

- **No request timeout** — SSE streams can run for hours
- **DinD rootless works** — sandbox isolation if you need it later
- **Full control** — SSH in, tail logs, debug
- **Simple** — one `docker compose up`, no ECS/ALB/task-definition ceremony
- **Cheap** — t3.medium is ~$30/mo, covered by AWS credits

## Prerequisites

- AWS account with EC2 access
- A domain name pointed at your instance (for Caddy's auto-TLS)
- An Anthropic API key

## 1. Write your agent

No Dockerfile needed — use the published `budd/claude-code:latest` image and
bind-mount your persona files into the container. A persona is just a
`CLAUDE.md` and a `.claude/settings.json`; updating either is a file
edit, not a rebuild.

```
my-agent/
├── CLAUDE.md                    # Agent instructions
├── .claude/
│   └── settings.json            # Tool permissions
├── docker-compose.yml           # Compose stack
└── Caddyfile                    # Reverse proxy + auto-TLS
```

**docker-compose.yml:**

```yaml
services:
  budd:
    image: budd/claude-code:latest
    restart: unless-stopped
    command: ["--runtime", "local"]
    environment:
      - BUDD_TOKEN=${BUDD_TOKEN}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    volumes:
      - ./:/workspace                  # CLAUDE.md + .claude/ live here
      - claude-data:/root/.claude      # persist session state across restarts
    expose:
      - "8080"

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config

volumes:
  claude-data:
  caddy-data:
  caddy-config:
```

**Caddyfile:**

```
agent.yourdomain.com {
    reverse_proxy budd:8080
}
```

That's the entire stack. Caddy handles Let's Encrypt certificates
automatically — no certbot, no cron, no renewal scripts.

> Pin a version in production (`budd/claude-code:0.3.0`) so `docker compose pull`
> doesn't silently upgrade you. If you need to pin the Claude CLI version
> or bake site-specific tooling in, see
> [deploy-dind-multi-agent.md §8](deploy-dind-multi-agent.md#8-building-a-custom-dind-image)
> for the custom-image path — the same pattern applies to the single-agent
> image.

## 2. Test locally

```bash
cd my-agent

# Create a .env file
echo "BUDD_TOKEN=$(openssl rand -hex 32)" > .env
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env

docker compose up
```

Test in another terminal:

```bash
source .env
curl -N -H "Authorization: Bearer $BUDD_TOKEN" \
     -H "content-type: application/json" \
     -d '{"prompt":"hello"}' \
     http://localhost:8080/sessions
```

(Caddy will complain about TLS locally since you don't have the domain
pointed at localhost — that's fine, hit budd directly on 8080 for local
testing.)

## 3. Launch an EC2 instance

### Option A: AWS Console

1. Go to **EC2** > **Launch instance**
2. **AMI:** Amazon Linux 2023 or Ubuntu 24.04
3. **Instance type:** `t3.medium` (2 vCPU, 4 GB — comfortable for one agent)
4. **Key pair:** create or select one for SSH access
5. **Security group:** allow inbound **80**, **443** (HTTP/HTTPS), and **22** (SSH)
6. **Storage:** 30 GB gp3 (default is fine)
7. Launch

### Option B: AWS CLI

```bash
# Create a security group
aws ec2 create-security-group \
  --group-name budd-sg \
  --description "budd agent server"

SG_ID=$(aws ec2 describe-security-groups \
  --group-names budd-sg \
  --query 'SecurityGroups[0].GroupId' --output text)

# Allow SSH, HTTP, HTTPS
aws ec2 authorize-security-group-ingress --group-id $SG_ID \
  --protocol tcp --port 22 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id $SG_ID \
  --protocol tcp --port 80 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id $SG_ID \
  --protocol tcp --port 443 --cidr 0.0.0.0/0

# Launch (Amazon Linux 2023, t3.medium)
aws ec2 run-instances \
  --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --instance-type t3.medium \
  --key-name your-key-pair \
  --security-group-ids $SG_ID \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3"}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=budd-agent}]'
```

## 4. Point your domain

Get the instance's public IP:

```bash
aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=budd-agent" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
```

Add an **A record** in your DNS provider:

```
agent.yourdomain.com → <instance-public-ip>
```

> If you don't have a domain, you can use the instance's public IP directly
> and skip Caddy (just expose port 8080 in the security group). You won't
> get HTTPS, but it works for testing.

## 5. Set up the instance

SSH in and install Docker:

```bash
ssh -i your-key.pem ec2-user@<instance-ip>

# Amazon Linux 2023
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user

# Install Docker Compose plugin
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Log out and back in for group change
exit
ssh -i your-key.pem ec2-user@<instance-ip>
```

For Ubuntu:

```bash
ssh -i your-key.pem ubuntu@<instance-ip>

sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo systemctl enable --now docker
sudo usermod -aG docker ubuntu
exit
ssh -i your-key.pem ubuntu@<instance-ip>
```

## 6. Deploy

Copy your agent files to the instance and start the stack:

```bash
# From your local machine
scp -i your-key.pem -r my-agent/ ec2-user@<instance-ip>:~/

# On the instance
ssh -i your-key.pem ec2-user@<instance-ip>
cd my-agent

# Create .env with your secrets
cat > .env << 'EOF'
BUDD_TOKEN=<your-token>
ANTHROPIC_API_KEY=<your-key>
EOF

# Start the stack
docker compose up -d
```

Check it's running:

```bash
docker compose ps
docker compose logs -f budd
```

## 7. Hit it

```bash
curl -N -H "Authorization: Bearer $BUDD_TOKEN" \
     -H "content-type: application/json" \
     -d '{"prompt":"fix the auth bug in src/middleware.ts"}' \
     https://agent.yourdomain.com/sessions
```

Caddy has already obtained a TLS certificate. HTTPS just works.

## Updating the agent

When you change `CLAUDE.md` or any agent files, copy them to the instance.
The workspace is bind-mounted, so no rebuild and no container restart is
needed — new sessions pick up the updated persona immediately. (In-flight
sessions continue with their original mounted snapshot.)

```bash
# From your local machine
scp -i your-key.pem CLAUDE.md ec2-user@<instance-ip>:~/my-agent/
scp -i your-key.pem -r .claude/ ec2-user@<instance-ip>:~/my-agent/
```

Or keep personas in git on the instance and `git pull`.

To upgrade the budd / Claude CLI itself:

```bash
ssh -i your-key.pem ec2-user@<instance-ip>
cd my-agent
docker compose pull && docker compose up -d
```

## Session persistence

The `claude-data` Docker volume persists `~/.claude` across container
restarts and redeployments. Session state survives `docker compose down`
and `docker compose up` — you can resume sessions after updating your agent.

To back up session data:

```bash
docker compose exec budd tar czf - /root/.claude > claude-backup.tar.gz
```

## Upgrading to DinD (sandboxed runtime)

If you later need per-session container isolation or want to run mixed
Claude/Codex personas from one daemon, this same EC2 instance supports
rootless DinD. Swap `budd/claude-code:latest` for `budd/dind:latest` and change
`--runtime local` to `--runtime docker`. EC2 allows the user namespace
syscalls that App Runner and Fargate block.

See [deploy-dind-multi-agent.md](deploy-dind-multi-agent.md) for the full
DinD walkthrough.

## Cost

| Component | Cost |
|-----------|------|
| t3.medium (2 vCPU, 4 GB) | ~$30/mo |
| 30 GB gp3 EBS | ~$2.40/mo |
| Data transfer (first 100 GB) | free |
| **Total** | **~$33/mo** |

> Use a Reserved Instance or Savings Plan to cut this to ~$19/mo for a
> 1-year commitment. Spot instances (`t3.medium` spot is ~$10/mo) work
> too if you can tolerate occasional interruptions.

## Troubleshooting

**Caddy won't issue a certificate:**
- Check that your domain's A record points to the instance's public IP
- Ensure ports 80 and 443 are open in the security group
- Check Caddy logs: `docker compose logs caddy`

**budd won't start:**
- Check logs: `docker compose logs budd`
- Most common: missing `BUDD_TOKEN` or `ANTHROPIC_API_KEY` in `.env`

**Can't connect after reboot:**
- EC2 public IPs change on stop/start unless you use an Elastic IP
- Allocate one: `aws ec2 allocate-address` then associate it with your instance

**Out of disk space:**
- Docker images accumulate: `docker system prune -f`
- Claude session logs can grow: check `docker compose exec budd du -sh /root/.claude`
