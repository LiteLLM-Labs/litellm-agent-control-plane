# AWS Deployment Guide

Web and worker run as Kubernetes Deployments inside the same EKS cluster as the agent sandboxes. No Render runtime, no static AWS credentials in environment variables.

---

## Architecture

```
GitHub Actions (push to main)
  → docker build → ECR push
  → kubectl set image → EKS rolling deploy

EKS cluster (litellm-agents, us-east-1)
  ├── litellm-web Deployment     ← Next.js, port 10000, LoadBalancer Service
  ├── litellm-worker Deployment  ← reconciler + warm pool
  └── sandbox pods (s-*, w-*)    ← agent harnesses (Sandbox CRs)

Auth: ServiceAccount token (no AWS keys for K8s API access)
URL:  http://ae7fbba6b9bd94fb8ae7aa4640d70da1-1735666001.us-east-1.elb.amazonaws.com
```

---

## One-time setup (already done)

These were completed once. Document here in case the cluster is torn down and recreated.

### 1. ECR repository

```bash
aws ecr create-repository \
  --repository-name litellm-agent-platform \
  --region us-east-1 \
  --image-scanning-configuration scanOnPush=true
```

### 2. GitHub OIDC provider

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

### 3. IAM role for GitHub Actions

```bash
# Trust policy (replace ACCOUNT_ID)
cat > /tmp/trust.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::888602223428:oidc-provider/token.actions.githubusercontent.com"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringLike": {
        "token.actions.githubusercontent.com:sub": "repo:BerriAI/litellm-agent-platform:ref:refs/heads/main"
      },
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
      }
    }
  }]
}
EOF

aws iam create-role \
  --role-name litellm-github-actions \
  --assume-role-policy-document file:///tmp/trust.json

aws iam attach-role-policy \
  --role-name litellm-github-actions \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser

aws iam create-policy \
  --policy-name litellm-eks-deploy \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["eks:DescribeCluster","eks:ListClusters"],"Resource":"arn:aws:eks:us-east-1:888602223428:cluster/litellm-agents"}]}'

aws iam attach-role-policy \
  --role-name litellm-github-actions \
  --policy-arn arn:aws:iam::888602223428:policy/litellm-eks-deploy
```

### 4. Grant GitHub Actions role access to EKS (aws-auth)

```bash
aws eks update-kubeconfig --name litellm-agents --region us-east-1

# Add to aws-auth ConfigMap — see current content first:
kubectl get configmap aws-auth -n kube-system -o yaml

# Patch to add:
#   - rolearn: arn:aws:iam::888602223428:role/litellm-github-actions
#     username: github-actions
#     groups:
#     - system:masters
```

### 5. Kubernetes RBAC

```bash
kubectl apply -f k8s/rbac-platform.yaml
```

Creates ServiceAccount `litellm-platform` with a long-lived token Secret and Role/ClusterRole for all K8s operations the platform needs.

### 6. Build and push harness images

Every harness (`claude-code`, `claude-agent-sdk`, `opencode`, `codex`,
`hermes`, `gemini`) has its own container image that runs inside each sandbox
pod. All harnesses share a common base image that must be built first.

```bash
REGISTRY=<your-account-id>.dkr.ecr.<region>.amazonaws.com/litellm-agent-platform

# Authenticate Docker to ECR
aws ecr get-login-password --region <region> | \
  docker login --username AWS --password-stdin "$REGISTRY"

# 1. Build the shared base image (never pushed — local build dep only)
docker build -f harnesses/base/Dockerfile -t harnesses/base:dev .

# 2. Build and push each harness
for HARNESS in claude-code claude-agent-sdk opencode codex hermes gemini; do
  IMG="$REGISTRY:harness-${HARNESS}-latest"
  docker buildx build -f harnesses/${HARNESS}/Dockerfile -t "$IMG" .
  docker push "$IMG"
  echo "pushed $IMG"
done
```

> **Note:** `harnesses/base:dev` must exist in the local Docker daemon before
> any harness build — the harness Dockerfiles all start with
> `FROM harnesses/base:dev`. It is never pushed to ECR; it's a local
> build-time dependency only.

After initial setup, CI handles this automatically on every push to `main`
via `.github/workflows/deploy-eks.yml`.

### 7. Application secrets

```bash
# Copy k8s/secrets.yaml, fill in real values, apply — never commit with values
cp k8s/secrets.yaml /tmp/litellm-env-filled.yaml
# edit /tmp/litellm-env-filled.yaml
kubectl apply -f /tmp/litellm-env-filled.yaml
```

Required keys in the `litellm-env` Secret:

| Key | Description |
|-----|-------------|
| `MASTER_KEY` | Platform auth key |
| `DATABASE_URL` | Neon Postgres connection string |
| `LITELLM_API_KEY` | LiteLLM gateway key |
| `LITELLM_API_BASE` | LiteLLM gateway URL |
| `K8S_HARNESS_IMAGE_CLAUDE_CODE` | ECR URI for `claude-code` harness image |
| `K8S_HARNESS_IMAGE_CLAUDE_SDK` | ECR URI for `claude-agent-sdk` harness image |
| `K8S_HARNESS_IMAGE_OPENCODE` | ECR URI for `opencode` harness image |
| `K8S_HARNESS_IMAGE_CODEX` | ECR URI for `codex` harness image |
| `K8S_HARNESS_IMAGE_HERMES` | ECR URI for `hermes` harness image |
| `K8S_HARNESS_IMAGE_GEMINI` | ECR URI for `gemini` harness image |
| `WARM_POOL_SIZE` | Shared warm-pool budget for all agents (e.g. `6`) |
| `WARM_POOL_PRIORITY_AGENT_ID` | Agent ID that gets a dedicated warm-pool budget (e.g. your default coding agent) |
| `WARM_POOL_PRIORITY_SIZE` | How many warm pods to keep for the priority agent (e.g. `10`); requires `WARM_POOL_PRIORITY_AGENT_ID` |
| `K8S_NODEPORT_MIN` | NodePort range start (e.g. `30000`) |
| `K8S_NODEPORT_MAX` | NodePort range end (e.g. `30099`) |

`K8S_HARNESS_IMAGE` (singular) is still accepted as a fallback for all
harnesses if the per-harness keys are not set. All other keys are optional or
have defaults.

### 8. GitHub repository secrets

```
AWS_ROLE_ARN    = arn:aws:iam::888602223428:role/litellm-github-actions
AWS_ACCOUNT_ID  = 888602223428
AWS_REGION      = us-east-1
EKS_CLUSTER_NAME = litellm-agents
```

Set via: `gh secret set <KEY> --body "<VALUE>" --repo BerriAI/litellm-agent-platform`

### 9. Initial deploy

```bash
# First deploy: use kubectl apply directly
aws eks update-kubeconfig --name litellm-agents --region us-east-1

GIT_SHA=$(git rev-parse HEAD) envsubst '${GIT_SHA}' < k8s/web.yaml | kubectl apply -f -
GIT_SHA=$(git rev-parse HEAD) envsubst '${GIT_SHA}' < k8s/worker.yaml | kubectl apply -f -
```

Subsequent deploys happen automatically on every push to `main` via `.github/workflows/deploy-eks.yml`.

---

## Day-to-day operations

### Deploy

Push to `main`. GitHub Actions builds the image, pushes to ECR, and rolls out both deployments. No manual steps.

```bash
git push origin main
# Watch: gh run watch --repo BerriAI/litellm-agent-platform
```

### Check status

```bash
kubectl get pods -n default -l 'app in (litellm-web,litellm-worker)'
kubectl logs -n default -l app=litellm-web --tail=50
kubectl logs -n default -l app=litellm-worker --tail=50
```

### K8s health check

```bash
curl -H "Authorization: Bearer $MASTER_KEY" \
  http://ae7fbba6b9bd94fb8ae7aa4640d70da1-1735666001.us-east-1.elb.amazonaws.com/api/v1/health/k8s
# → {"ok":true,"elapsed_ms":NNN}
```

### Update a secret value

```bash
kubectl patch secret litellm-env -n default \
  --type='json' \
  -p="[{\"op\":\"replace\",\"path\":\"/data/MASTER_KEY\",\"value\":\"$(echo -n 'newvalue' | base64)\"}]"

# Restart to pick up new value:
kubectl rollout restart deployment/litellm-web deployment/litellm-worker -n default
```

### Scale warm pool

```bash
kubectl patch secret litellm-env -n default \
  --type='json' \
  -p="[{\"op\":\"replace\",\"path\":\"/data/WARM_POOL_SIZE\",\"value\":\"$(echo -n '10' | base64)\"}]"
kubectl rollout restart deployment/litellm-worker -n default
```

### Clean up stale sandbox pods

If the reconciler was down and pods accumulated:

```bash
kubectl delete sandboxes.agents.x-k8s.io -n default -l litellm-session-id --grace-period=0
kubectl delete sandboxes.agents.x-k8s.io -n default -l litellm-warm-task-id --grace-period=0
kubectl delete services -n default -l litellm-session-id --grace-period=0
```

---

## Credentials

| Credential | Where | Notes |
|---|---|---|
| AWS keys for K8s | **Not used** | ServiceAccount token handles K8s auth |
| AWS keys for ECR push | GitHub Actions OIDC | Short-lived, auto-rotated — no static keys |
| `MASTER_KEY` | `litellm-env` Secret | Rotate: patch secret + rollout restart |
| `DATABASE_URL` | `litellm-env` Secret | Neon Postgres |
| `LITELLM_API_KEY` | `litellm-env` Secret | LiteLLM gateway |

No static AWS access keys anywhere. AWS auth is OIDC (GitHub → IAM role) for CI and ServiceAccount token (pod identity) for runtime.

---

## Cluster details

| Resource | Value |
|---|---|
| Cluster | `litellm-agents` |
| Region | `us-east-1` |
| ECR repo | `888602223428.dkr.ecr.us-east-1.amazonaws.com/litellm-agent-platform` |
| Harness image | `888602223428.dkr.ecr.us-east-1.amazonaws.com/litellm-agents-opencode:latest` |
| Web URL | `http://ae7fbba6b9bd94fb8ae7aa4640d70da1-1735666001.us-east-1.elb.amazonaws.com` |
| ServiceAccount | `litellm-platform` (namespace: `default`) |
| IAM role (CI) | `arn:aws:iam::888602223428:role/litellm-github-actions` |
