# Deploy the Devin Managed Agents server on EKS

## Agent prompt (recommended)

Paste this into Claude Code (or any capable coding agent) and it will deploy the
stack, asking you for whatever it needs:

```text
Deploy the devin-agent-server stack to an EKS cluster.
Use the deployment guide at:
https://github.com/LiteLLM-Labs/litellm-agent-control-plane/blob/main/templates/devin/docs/eks-deploy-prompt.md

Work through every step. Ask me for anything you need (AWS creds, region, Devin
credentials — either WINDSURF_API_KEY or a host that has run `devin auth login`).
Do not guess. Verify the deployment with a live health check and a test message
before reporting done.
```

Or use the full self-contained prompt directly: [`eks-deploy-prompt.md`](./eks-deploy-prompt.md)

---

<details>
<summary><strong>Manual deployment guide</strong></summary>

## Overview

This stack runs the [Devin CLI](https://devin.ai/cli) as an AI agent backend
behind the **Anthropic Managed Agents API spec**. Any client that speaks that
spec — including the LiteLLM Agent Platform (LAP) SDK's `claude_managed_agents`
runtime — drives it with zero code changes.

**Components:**

- **devin-agent-server** — Node.js Express app that translates the Anthropic
  Managed Agents API into the Agent Client Protocol (ACP). Spawns `devin acp` as
  a child process, persists agent/session state in SQLite, and rewrites ACP
  `session/update` notifications into Anthropic event shapes.
- **Devin CLI** — the agent runtime. `devin acp` reads credentials from
  `devin auth login` on the host, or from `WINDSURF_API_KEY` if set. Routes
  model calls through your Devin account — no gateway API key is involved.

**Data flow:**
```text
LAP SDK (claude_managed_agents)
  -> devin-agent-server   (Anthropic Managed Agents API, port 80)
       -> devin acp        (child process, ACP JSON-RPC over stdio)
           -> Devin models (via your Devin account)
```

## Prerequisites

- An EKS cluster with a node group that can run your workloads.
- `kubectl` configured against the cluster.
- Devin credentials: either a `WINDSURF_API_KEY`, or the Devin config dir
  produced by `devin auth login` on a host, mounted into the pod.
- A container image registry you can push to (or use the public image once
  published).

## 1. Build and push the image

```bash
cd templates/devin
docker build --platform linux/amd64 -t <registry>/devin-agent-server:latest .
docker push <registry>/devin-agent-server:latest
```

## 2. Provide Devin credentials

`devin acp` reads credentials from `devin auth login` on the host, or from
`WINDSURF_API_KEY`. In a pod you can't run `auth login` interactively, so either
set `WINDSURF_API_KEY` as a secret, or mount the Devin config dir from a host
that has already run `devin auth login`.

Option A — `WINDSURF_API_KEY` as a secret (alternative to `auth login`):

```bash
kubectl create secret generic devin-creds \
  --from-literal=WINDSURF_API_KEY=<your-windsurf-api-key>
```

Option B — mount the host's `~/.config/devin` dir (read-only) via a hostPath or
projected volume. The path inside the container must be `/root/.config/devin`
(since the image runs as root, matching the opencode template).

## 3. Deploy

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: devin-agent-server
spec:
  replicas: 1
  selector:
    matchLabels: { app: devin-agent-server }
  template:
    metadata:
      labels: { app: devin-agent-server }
    spec:
      containers:
        - name: devin-agent-server
          image: <registry>/devin-agent-server:latest
          ports: [{ containerPort: 8080 }]
          envFrom:
            - secretRef: { name: devin-creds }
          env:
            - { name: PORT, value: "8080" }
            - { name: WORKDIR, value: /tmp/devin-workspace }
            - { name: DB_PATH, value: /data/agents.db }
          volumeMounts:
            - { name: data, mountPath: /data }
            - { name: workspace, mountPath: /tmp/devin-workspace }
          readinessProbe:
            httpGet: { path: /ready, port: 8080 }
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /health, port: 8080 }
            initialDelaySeconds: 10
            periodSeconds: 20
      volumes:
        - { name: data, emptyDir: {} }
        - { name: workspace, emptyDir: {} }
---
apiVersion: v1
kind: Service
metadata:
  name: devin-agent-server
spec:
  selector: { app: devin-agent-server }
  ports: [{ port: 80, targetPort: 8080 }]
```

> Replace `emptyDir` volumes with persistent volumes for durable agent state
> across restarts.

## 4. Register in LAP

Point LAP at the in-cluster service:

| Field | Value |
|-------|-------|
| API Spec | `claude_managed_agents` |
| API Base | `http://devin-agent-server.default.svc.cluster.local` |

## 5. Verify

```bash
kubectl port-forward svc/devin-agent-server 8080:80
curl http://localhost:8080/health          # {"ok":true,"devin":true}
curl http://localhost:8080/v1/models       # { "object": "list", "data": [...] }
```

Then run the smoke test:

```bash
BASE=http://localhost:8080 MODEL=opus templates/devin/scripts/smoke.sh
```

</details>
