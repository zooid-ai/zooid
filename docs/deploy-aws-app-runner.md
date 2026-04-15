# Deploy budd to AWS App Runner

App Runner is the simplest way to run budd on AWS: push an image, get an
HTTPS endpoint. No VPC, no load balancer, no EC2 instances to manage.

budd runs in **local runtime** mode on App Runner (budd + claude live in the
same container). The local runtime is all you need for a single-agent
deployment.

> **DinD on App Runner?** Our rootless-DinD image (`budd/dind`) uses
> RootlessKit + user namespaces and does *not* need `--privileged` on
> Linux hosts — it only needs it on Mac/Docker-Desktop. App Runner runs
> on Linux, so it should in theory be able to host the multi-agent DinD
> image, giving you per-session sandboxing without an EC2 box. We
> haven't verified this end-to-end (App Runner also blocks
> `--security-opt` and `--device`, which rootless dockerd sometimes
> wants for fuse-overlayfs), so treat it as a promising but unproven
> path. If you try it, please report back. The rest of this doc covers
> the shipping-today **local runtime** path.

## Prerequisites

- AWS CLI configured (`aws configure`)
- Docker installed locally
- An Anthropic API key

## 1. Create your agent image

Start with a `Dockerfile` for your agent:

```dockerfile
FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm i -g @anthropic-ai/claude-code @zooid/budd

WORKDIR /workspace

# Agent personality and permissions
COPY CLAUDE.md .
COPY .claude/ .claude/

# Optional: hooks, port override
# COPY daemon.yaml .

EXPOSE 8080
ENTRYPOINT ["budd", "--runtime", "local"]
```

Your directory should look like:

```
my-agent/
├── Dockerfile
├── CLAUDE.md                    # Agent instructions
└── .claude/
    └── settings.json            # Tool permissions
```

> **Tip:** If you're iterating locally, you can also `FROM budd/claude-code:local`
> using the locally-built base image. The Dockerfile above installs from npm
> so it works without the budd repo checked out.

## 2. Build and test locally

```bash
cd my-agent
docker build -t my-agent:latest .

# Quick smoke test
docker run --rm -p 8080:8080 \
  -e BUDD_TOKEN=test-token \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  my-agent:latest

# In another terminal:
curl -N -H "Authorization: Bearer test-token" \
     -H "content-type: application/json" \
     -d '{"prompt":"hello, what can you do?"}' \
     http://localhost:8080/sessions
```

## 3. Push to ECR

Create a private ECR repository and push your image:

```bash
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=us-east-1  # change to your preferred region

# Create the repo (once)
aws ecr create-repository \
  --repository-name my-agent \
  --region $AWS_REGION

# Authenticate Docker to ECR
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin \
    $AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com

# Tag and push
docker tag my-agent:latest \
  $AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/my-agent:latest

docker push \
  $AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/my-agent:latest
```

## 4. Create the App Runner service

### Option A: AWS Console

1. Go to **App Runner** > **Create service**
2. Source: **Container registry** > **Amazon ECR**
3. Image URI: `<account>.dkr.ecr.<region>.amazonaws.com/my-agent:latest`
4. ECR access role: create a new one or use an existing role with
   `AWSAppRunnerServicePolicyForECRAccess`
5. Deployment trigger: **Manual** (or automatic if you want pushes to
   redeploy)
6. Configure service:
   - **Port:** `8080`
   - **CPU:** 1 vCPU (enough for most agents; scale up for parallel sessions)
   - **Memory:** 2 GB (claude code needs headroom)
   - **Environment variables:**
     - `BUDD_TOKEN` — generate with `openssl rand -hex 32`
     - `ANTHROPIC_API_KEY` — your Anthropic key
   - **Health check path:** leave default (TCP on port 8080)
7. Create and deploy

### Option B: AWS CLI

```bash
# Generate a token
BUDD_TOKEN=$(openssl rand -hex 32)
echo "Save this token: $BUDD_TOKEN"

# Create an ECR access role for App Runner (once)
aws iam create-role \
  --role-name AppRunnerECRAccess \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "build.apprunner.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name AppRunnerECRAccess \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess

# Wait for the role to propagate
sleep 10

ECR_ROLE_ARN=$(aws iam get-role --role-name AppRunnerECRAccess --query Role.Arn --output text)

# Create the service
aws apprunner create-service \
  --service-name my-agent \
  --source-configuration "{
    \"AuthenticationConfiguration\": {
      \"AccessRoleArn\": \"$ECR_ROLE_ARN\"
    },
    \"ImageRepository\": {
      \"ImageIdentifier\": \"$AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/my-agent:latest\",
      \"ImageRepositoryType\": \"ECR\",
      \"ImageConfiguration\": {
        \"Port\": \"8080\",
        \"RuntimeEnvironmentVariables\": {
          \"BUDD_TOKEN\": \"$BUDD_TOKEN\",
          \"ANTHROPIC_API_KEY\": \"$ANTHROPIC_API_KEY\"
        }
      }
    }
  }" \
  --instance-configuration '{
    "Cpu": "1024",
    "Memory": "2048"
  }' \
  --region $AWS_REGION
```

Wait for the service to reach `RUNNING` status:

```bash
aws apprunner describe-service \
  --service-arn $(aws apprunner list-services --query 'ServiceSummaryList[?ServiceName==`my-agent`].ServiceArn' --output text --region $AWS_REGION) \
  --query 'Service.{Status:Status,Url:ServiceUrl}' \
  --output table \
  --region $AWS_REGION
```

## 5. Hit it

App Runner gives you an HTTPS URL automatically:

```bash
SERVICE_URL=$(aws apprunner list-services \
  --query 'ServiceSummaryList[?ServiceName==`my-agent`].ServiceUrl' \
  --output text --region $AWS_REGION)

# Start a session
curl -N -H "Authorization: Bearer $BUDD_TOKEN" \
     -H "content-type: application/json" \
     -d '{"prompt":"fix the auth bug in src/middleware.ts"}' \
     https://$SERVICE_URL/sessions

# Resume a session
curl -N -H "Authorization: Bearer $BUDD_TOKEN" \
     -H "content-type: application/json" \
     -d '{"prompt":"also add a test for that fix"}' \
     https://$SERVICE_URL/sessions/$SESSION_ID/turns
```

## 6. Update the agent

When you change your `CLAUDE.md` or agent code, rebuild and push:

```bash
docker build -t my-agent:latest .
docker tag my-agent:latest $AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/my-agent:latest
docker push $AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/my-agent:latest

# Trigger a new deployment
aws apprunner start-deployment \
  --service-arn $(aws apprunner list-services --query 'ServiceSummaryList[?ServiceName==`my-agent`].ServiceArn' --output text --region $AWS_REGION) \
  --region $AWS_REGION
```

## Cost estimate

App Runner bills per vCPU-hour and GB-hour while the container is active,
plus a lower "paused" rate when idle (App Runner can pause containers that
receive no traffic).

| Resource | Active rate | Paused rate |
|----------|------------|-------------|
| vCPU     | ~$0.064/hr | ~$0.007/hr  |
| Memory   | ~$0.007/GB-hr | included |

A 1 vCPU / 2 GB agent that handles a few sessions per day and idles the
rest costs roughly **$5-15/month**. Heavy usage (always active) runs
closer to **$50-60/month**.

> These are approximate 2025 prices. Check the
> [App Runner pricing page](https://aws.amazon.com/apprunner/pricing/)
> for current rates.

## Scaling and concurrency

App Runner auto-scales based on concurrent requests. Each budd instance
handles one session at a time per the MVP design (the agent CLI is
single-threaded). To handle concurrent sessions, App Runner will spin up
additional container instances automatically.

Configure scaling in the console or via CLI:

```bash
aws apprunner update-service \
  --service-arn $SERVICE_ARN \
  --auto-scaling-configuration-arn $(aws apprunner create-auto-scaling-configuration \
    --auto-scaling-configuration-name budd-scaling \
    --max-concurrency 1 \
    --max-size 5 \
    --min-size 0 \
    --query 'AutoScalingConfiguration.AutoScalingConfigurationArn' \
    --output text \
    --region $AWS_REGION) \
  --region $AWS_REGION
```

Key settings:
- **`max-concurrency: 1`** — one request per instance (each session is
  long-lived, so this prevents contention)
- **`max-size: 5`** — up to 5 concurrent agents (adjust based on budget)
- **`min-size: 0`** — scale to zero when idle (saves cost)

## Session persistence

With `runtime: local`, Claude Code writes session state to
`~/.claude/projects/` inside the container. This state **does not persist**
across App Runner deployments or container recycling. Each new container
starts fresh.

For stateless agents (like the triage example) this is fine. If you need
session resume across deploys, you have two options:

1. **Mount an EFS volume** (App Runner supports EFS via VPC connector) at
   the claude home directory path.
2. **Use hooks** to persist state externally (`post_turn: "aws s3 sync ..."`)
   and restore it on startup.

## Troubleshooting

**Container fails to start:**
Check App Runner logs in CloudWatch. Common causes:
- Missing `ANTHROPIC_API_KEY` — claude code exits immediately
- Missing `BUDD_TOKEN` — budd refuses to start without auth

**SSE stream cuts off:**
App Runner has a request timeout (default 120s for HTTP). Agent turns that
take longer will be terminated. Increase the timeout:
```bash
aws apprunner update-service \
  --service-arn $SERVICE_ARN \
  --health-check-configuration '{"Protocol":"TCP","Path":"/","Interval":10,"Timeout":5}' \
  --region $AWS_REGION
```

For the request timeout itself, set it in the App Runner console under
**Networking** > **Request timeout** (max 120 seconds in App Runner).

> If your agent runs are consistently longer than 120s, consider ECS on
> Fargate (with `runtime: local`) which has no request timeout limit.

**Health check failing:**
budd doesn't serve a dedicated health endpoint yet. Use TCP health checks
on port 8080 (the default). The Hono server accepts connections as soon as
budd starts, so TCP checks pass immediately.
