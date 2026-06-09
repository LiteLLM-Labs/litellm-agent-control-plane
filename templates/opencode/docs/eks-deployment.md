# Deploy opencode + OpenSandbox on EKS

## Agent prompt (recommended)

Paste this into Claude Code (or any capable coding agent) and it will deploy the full stack, asking you for whatever it needs:

```
Deploy the opencode-anthropic-server + OpenSandbox stack to an EKS cluster.
Use the deployment guide at:
https://github.com/LiteLLM-Labs/litellm-agent-platform-2/blob/main/templates/opencode/docs/eks-deploy-prompt.md

Work through every step. Ask me for anything you need (AWS creds, region, LiteLLM
gateway URL/key, model name). Do not guess. Verify the deployment with a live health
check and a test message before reporting done.
```

Or use the full self-contained prompt directly: [`eks-deploy-prompt.md`](./eks-deploy-prompt.md)

---

<details>
<summary><strong>Manual deployment guide</strong></summary>

## Overview

This stack runs [opencode](https://opencode.ai) as a sandboxed AI agent backend behind the **Anthropic Managed Agents API spec**. Any client that speaks that spec — including the LiteLLM Agent Platform (LAP) SDK's `claude_managed_agents` runtime — drives it with zero code changes.

**Components:**

- **opencode-anthropic-server** — Node.js Express app that translates the Anthropic Managed Agents API into opencode. Spawns `opencode serve` as a child process, persists agent/session state in SQLite, rewrites opencode's SSE events into Anthropic event shapes.
- **OpenSandbox** — Kubernetes operator that manages sandbox lifecycle via BatchSandbox CRDs. Agent command/file ops are proxied into sandbox containers via OpenSandbox's HTTP API.
- **LiteLLM gateway** (external) — Routes model calls.

**Data flow:**
```
LAP SDK (claude_managed_agents)
  → opencode-anthropic-server  (Anthropic Managed Agents API, port 80)
      → opencode serve          (child process, port 4096)
          → OpenSandbox server  (sandbox exec/file ops, in-cluster HTTP)
              → BatchSandbox pods (actual isolated containers)
          → LiteLLM gateway     (model calls)
```

---

## 1. Prerequisites

Tools required: `eksctl`, `kubectl`, `helm`, `aws` CLI v2, `docker`.

AWS account needs:
- IAM permissions to create EKS clusters, EC2, VPCs, IAM roles, ECR
- VPC quota headroom (default 5 per region — check with `aws ec2 describe-vpcs --query 'length(Vpcs)'`)

---

## 2. EKS Cluster

```yaml
# cluster.yaml
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig
metadata:
  name: opensandbox
  region: eu-west-1
  version: "1.32"
managedNodeGroups:
  - name: workers
    instanceType: t3.medium
    desiredCapacity: 2
    volumeSize: 50
    iam:
      attachPolicyARNs:
        - arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy
        - arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy
        - arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly
        - arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy
```

```bash
eksctl create cluster -f cluster.yaml   # ~15–20 min
kubectl get nodes                        # verify Ready
```

---

## 3. EBS CSI Driver

Required for the opencode-anthropic-server PVC.

```bash
eksctl utils associate-iam-oidc-provider --cluster opensandbox --region eu-west-1 --approve

eksctl create iamserviceaccount \
  --name ebs-csi-controller-sa --namespace kube-system \
  --cluster opensandbox --region eu-west-1 \
  --attach-policy-arn arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy \
  --approve --role-only --role-name AmazonEKS_EBS_CSI_DriverRole_opensandbox

ROLE_ARN=$(aws iam get-role --role-name AmazonEKS_EBS_CSI_DriverRole_opensandbox \
  --query 'Role.Arn' --output text)

aws eks create-addon --cluster-name opensandbox --addon-name aws-ebs-csi-driver \
  --service-account-role-arn "$ROLE_ARN" --region eu-west-1

aws eks wait addon-active --cluster-name opensandbox \
  --addon-name aws-ebs-csi-driver --region eu-west-1

kubectl apply -f - <<'EOF'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
volumeBindingMode: WaitForFirstConsumer
EOF
```

---

## 4. OpenSandbox

Generate and save an API key:
```bash
OPENSANDBOX_API_KEY=$(openssl rand -hex 32)
```

```bash
git clone --depth=1 https://github.com/opensandbox-group/OpenSandbox.git
cd OpenSandbox/kubernetes

# Package sub-charts (avoids repo refresh errors)
helm package charts/opensandbox-controller -d charts/opensandbox/charts/
helm package charts/opensandbox-server     -d charts/opensandbox/charts/

kubectl create namespace opensandbox-system

helm install opensandbox charts/opensandbox \
  --namespace opensandbox-system \
  -f - <<EOF
opensandbox-controller:
  controller:
    snapshot:
      containerdSocketPath: ""   # fix: v0.2.0 chart passes stale flag that crashes controller
opensandbox-server:
  server:
    replicaCount: 1
    resources:
      requests: { cpu: 500m, memory: 512Mi }   # fix: default 4Gi request doesn't fit t3.medium
      limits:   { cpu: "2",  memory: 2Gi  }
  configToml: |
    [server]
    host = "0.0.0.0"
    port = 80
    api_key = "$OPENSANDBOX_API_KEY"
    [runtime]
    type = "kubernetes"
    execd_image = "sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/execd:v1.0.18"
    [kubernetes]
    namespace = "opensandbox"
    workload_provider = "batchsandbox"
    batchsandbox_template_file = "/etc/opensandbox/example.batchsandbox-template.yaml"
    [egress]
    image = "sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/egress:v1.0.12"
    mode = "dns+nft"
EOF
```

Verify:
```bash
kubectl -n opensandbox-system get pods
# opensandbox-controller-manager-xxx   1/1   Running
# opensandbox-server-xxx               1/1   Running
```

---

## 5. opencode-anthropic-server

### Build & push to ECR

Build directly from this template directory (the `Dockerfile` is here):

```bash
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR=$AWS_ACCOUNT_ID.dkr.ecr.eu-west-1.amazonaws.com/opencode-anthropic-server

aws ecr create-repository --repository-name opencode-anthropic-server --region eu-west-1
aws ecr get-login-password --region eu-west-1 | \
  docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.eu-west-1.amazonaws.com

# Run from the templates/opencode directory
docker build --platform linux/amd64 -t $ECR:latest .
docker push $ECR:latest
```

### Deploy

```bash
kubectl create secret generic opencode-server-secrets -n opensandbox-system \
  --from-literal=LITELLM_API_KEY=<your-litellm-key> \
  --from-literal=OPENSANDBOX_API_KEY=$OPENSANDBOX_API_KEY

kubectl apply -f - <<EOF
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: opencode-data
  namespace: opensandbox-system
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: gp3
  resources:
    requests:
      storage: 5Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opencode-anthropic-server
  namespace: opensandbox-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: opencode-anthropic-server
  template:
    metadata:
      labels:
        app: opencode-anthropic-server
    spec:
      initContainers:
        - name: db-cleanup
          image: busybox
          command: ["sh", "-c", "rm -f /data/agents.db-shm /data/agents.db-wal"]
          volumeMounts:
            - {name: data, mountPath: /data}
      containers:
        - name: server
          image: $ECR:latest
          ports:
            - containerPort: 8080
          env:
            - {name: WORKDIR,   value: /tmp/opencode-workspace}
            - {name: DB_PATH,   value: /data/agents.db}
            - name: LITELLM_BASE_URL
              value: https://<your-gateway>/v1
            - name: LITELLM_MODELS
              value: claude-sonnet-4-6
            - name: OPENSANDBOX_API_URL
              value: http://opensandbox-server.opensandbox-system.svc.cluster.local
            - name: OPENSANDBOX_IMAGE
              value: sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/execd:v1.0.18
            - name: LITELLM_API_KEY
              valueFrom:
                secretKeyRef: {name: opencode-server-secrets, key: LITELLM_API_KEY}
            - name: OPENSANDBOX_API_KEY
              valueFrom:
                secretKeyRef: {name: opencode-server-secrets, key: OPENSANDBOX_API_KEY}
          volumeMounts:
            - {name: data, mountPath: /data}
          resources:
            requests: {cpu: 250m, memory: 512Mi}
            limits:   {cpu: "1",  memory: 2Gi}
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: opencode-data
---
apiVersion: v1
kind: Service
metadata:
  name: opencode-anthropic-server
  namespace: opensandbox-system
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: nlb
spec:
  type: LoadBalancer
  selector:
    app: opencode-anthropic-server
  ports:
    - {port: 80, targetPort: 8080}
EOF
```

---

## 6. Verify

```bash
LB=$(kubectl -n opensandbox-system get svc opencode-anthropic-server \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

curl -s http://$LB/health
# {"ok":true,"opencode":true}
```

Point the LAP SDK at `http://$LB` with model `claude-sonnet-4-6`, or register
the runtime in the LAP UI with the [README walkthrough](../README.md#connect-from-lap).

For a full end-to-end smoke test (agent → session → message → stream), use the included script:

```bash
BASE=http://$LB MODEL=claude-sonnet-4-6 ../scripts/smoke.sh
```

See [`scripts/smoke.sh`](../scripts/smoke.sh) for what it covers.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Controller CrashLoopBackOff | `unknown flag: --containerd-socket-path` in logs — v0.2.0 chart bug | Set `containerdSocketPath: ""` in helm values |
| Server pods Pending | Default 4Gi RAM request exceeds t3.medium capacity | Set `requests.memory: 512Mi` in helm values |
| Server exits immediately | `api_key` empty in config.toml | Provide non-empty `api_key` in `configToml` |
| PVC stuck Pending | EBS CSI addon not installed or gp3 StorageClass missing | Run steps in section 3 |
| LB EXTERNAL-IP pending | NLB provisioning in progress | Wait 60–90s; check subnet tags if longer than 5 min |
| `opencode: false` in health | opencode child crashed | Check logs: `kubectl -n opensandbox-system logs deployment/opencode-anthropic-server` |

</details>
