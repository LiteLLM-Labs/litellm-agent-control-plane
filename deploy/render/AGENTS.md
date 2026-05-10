# Render deploy — agent handover

Brief for an automated agent (or anyone re-bootstrapping this stack)
that needs to deploy the litellm-agent-platform onto Render against an
external Kubernetes sandbox cluster. Read this before touching the
Render API.

## Inputs the agent needs

| Variable                | Source                                            |
|-------------------------|---------------------------------------------------|
| `RENDER_API_KEY`        | https://dashboard.render.com/u/settings/api-keys  |
| `DATABASE_URL`          | Postgres provider (Neon / Supabase / Render PG)   |
| `LITELLM_API_BASE`      | OpenAI-compatible /chat/completions endpoint      |
| `LITELLM_API_KEY`       | API key for the above                             |
| `KUBE_CONFIG_B64`       | base64 of the EKS / GKE / k3s kubeconfig          |
| `K8S_NODE_HOST`         | `auto` (recommended — platform discovers Ready node IP via apiserver, 30s cache) or a stable LB hostname |
| `K8S_HARNESS_IMAGE`     | registry path of the opencode-sandbox image       |

## Order of operations

1. **Provision the sandbox cluster.** Run [`bin/eks-up.sh`](../../bin/eks-up.sh)
   for AWS, [`bin/k3s-up.sh`](../../bin/k3s-up.sh) for Fly. Both write
   the base64 kubeconfig to stdout; capture with `>kube-config.b64`. Both
   print `K8S_NODE_HOST=...` to stderr — extract it.
2. **Verify the kubeconfig works locally** before pushing to Render:
   ```bash
   base64 -d < kube-config.b64 > /tmp/kc && KUBECONFIG=/tmp/kc kubectl get nodes
   KUBECONFIG=/tmp/kc kubectl get crd | grep sandboxes.agents.x-k8s.io
   ```
   `kubectl get nodes` must return at least one Ready node.
   `agent-sandbox` CRD must be present.
3. **Find your Render `ownerId`**:
   ```bash
   curl -sH "Authorization: Bearer $RENDER_API_KEY" https://api.render.com/v1/owners
   ```
4. **Generate `MASTER_KEY`**: `openssl rand -hex 16`. Save once, set on
   both services.
5. **Create web service** (`POST /v1/services`). See body shape below.
6. **Create worker service** (`POST /v1/services`). Same envs, different
   `type` and start command.
7. **Poll `/v1/services/<id>/deploys?limit=1`** until `status: live` or
   `*failed*`. Build phase ~3-5 min on starter plan.
8. **Smoke**: `GET https://<service-url>/login` → expect 200.

## Service body shape (POST /v1/services)

```json
{
  "type": "web_service",
  "name": "litellm-agents-web",
  "ownerId": "<from step 3>",
  "repo": "https://github.com/BerriAI/litellm-agent-platform",
  "branch": "main",
  "autoDeploy": "no",
  "serviceDetails": {
    "runtime": "node",
    "envSpecificDetails": {
      "buildCommand": "npm ci --include=dev && npx prisma generate && npm run build",
      "preDeployCommand": "npx prisma migrate deploy",
      "startCommand": "npm start"
    },
    "healthCheckPath": "/login",
    "plan": "starter"
  },
  "envVars": [/* see below */]
}
```

Worker variant: `"type": "background_worker"`, no `healthCheckPath`,
build = `npm ci --include=dev && npx prisma generate`,
start = `npm run worker`.

## Env vars (set on BOTH services, identical)

```
NODE_ENV=production
DATABASE_URL=<from above>
MASTER_KEY=<generated>
UI_USERNAME=admin
LITELLM_API_BASE=<from above>
LITELLM_API_KEY=<from above>
LITELLM_DEFAULT_MODEL=anthropic/claude-sonnet-4-6
PREINSTALLED_GITHUB_REPO=https://github.com/BerriAI/litellm
KUBE_CONFIG_B64=<from kube-config.b64>
K8S_NODE_HOST=auto
K8S_HARNESS_IMAGE=<registry path>
K8S_NAMESPACE=default
K8S_NODEPORT_MIN=30000
K8S_NODEPORT_MAX=30099
K8S_IMAGE_PULL_POLICY=IfNotPresent
WARM_POOL_SIZE=2
```

## Known traps

- **`npm ci` strips devDependencies under NODE_ENV=production.** Always
  use `--include=dev` in the build command. Tailwind + Turbopack are
  devDeps; build fails with `Cannot find module '@tailwindcss/postcss'`
  otherwise.
- **`bin/eks-up.sh` extracted the wrong cluster server URL pre-fix.** It
  used `kubectl config view ... clusters[0]`, which picks whichever
  cluster the host kubeconfig listed first. Fixed to read directly from
  `aws eks describe-cluster`. If you're using an old version of the
  script, regenerate the kubeconfig.
- **EKS service-account tokens cap at 24h.** Even if you pass
  `--duration=87600h`, EKS shortens it. Re-run `bin/eks-up.sh`
  on a daily cron, or move to IRSA for the in-cluster path.
- **Wrong commit deployed.** Render auto-deploys from the configured
  branch's HEAD at service-create time. If you need a specific commit,
  `POST /v1/services/<id>/deploys -d '{"commitId":"<sha>"}'`.
- **Stale `ready` rows in the DB after re-pointing the cluster.** If
  this database previously served a different sandbox runtime (local
  kind, prior EKS, etc.), the `Session` table will have rows whose
  `sandbox_url` points at unreachable hosts. The reconciler ghost-reaps
  them within `RECONCILE_INTERVAL_SECONDS` (default 60s). To force a
  clean slate: `DELETE FROM "Session" WHERE status='ready';` before the
  first request.
- **Kubeconfig `clusters[0].cluster.server` is mandatory for the
  platform to dial the apiserver.** If the agent reads the kubeconfig
  via `kubectl config view --raw -o jsonpath='{.clusters[?(@.name==
  "litellm-agents")].cluster.server}'`, that's the correct shape.

## Verification checklist

After both services report `live`:

- [ ] `curl https://<web-url>/login` → 200
- [ ] Worker logs (`GET /v1/services/<id>/logs?limit=50`) contain
      `reconciler worker started`
- [ ] Login with `MASTER_KEY`, create an agent, click "Spawn session"
- [ ] Watch web logs for the spawn round-trip; first cold spawn ~30-60s
      due to image pull from the registry
- [ ] On second click, spawn should land in <2s (warm pool kicks in
      after the first worker tick has provisioned)

## Failure modes and their fixes

| Symptom in logs                                                     | Fix |
|---------------------------------------------------------------------|-----|
| `Cannot find module '@tailwindcss/postcss'`                          | build command missing `--include=dev` |
| `request to https://X.X.X.X/apis/agents.x-k8s.io/...` ECONNRESET     | wrong kubeconfig server URL — regenerate via `aws eks describe-cluster` |
| `connect ECONNREFUSED 127.0.0.1:300NN`                              | stale `ready` Session row from prior local dev — wait 60s for ghost reaper, or `DELETE` from DB |
| `Sandbox CR ... is forbidden: User cannot create resource` | service-account token expired (24h cap on EKS) — rerun `bin/eks-up.sh` |
| `ImagePullBackOff` on Sandbox pods                                   | cluster nodes can't pull from your registry — check IAM (ECR), imagePullSecret (private GHCR), or push to a public registry |
