# EKS Deployment Agent Prompt

Paste this into any capable coding agent (Claude Code, etc.) to deploy opencode-anthropic-server + OpenSandbox to EKS.

---

```
You are deploying the opencode-anthropic-server + OpenSandbox stack to an EKS cluster.
This gives the LiteLLM Agent Platform a sandboxed AI agent backend behind the Anthropic
Managed Agents API. Agents run in isolated containers; clients connect with just an api_base URL.

## Your job

Work through the deployment end-to-end. At each step, check whether you already have what
you need. If not, ask the user. Never guess at credentials or region. Once the stack is
running, verify it with a live health check and a test message.

## What you need from the user (ask if not provided)

- AWS credentials (access key + secret, or confirm they're already configured in the shell)
- AWS region (e.g. us-east-1, eu-west-1)
- LiteLLM gateway URL and API key (e.g. https://your-gateway/v1 + sk-...)
- LiteLLM model name to register (e.g. claude-sonnet-4-6)
- Docker registry — ECR is recommended; ask for the AWS account ID or confirm you can
  create an ECR repo

## Steps to execute

### 1. Prerequisites check
Verify these are installed: eksctl, kubectl, helm, aws CLI, docker.
Install any that are missing.

### 2. Check VPC quota
```bash
aws ec2 describe-vpcs --region <region> --query 'length(Vpcs)'
```
Default limit is 5. If at limit, ask the user to pick a different region or delete an
unused VPC before continuing.

### 3. Create EKS cluster
Write and apply this eksctl config (fill in the user's region):

```yaml
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig
metadata:
  name: opensandbox
  region: <region>
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

This takes 15–20 minutes. Wait for it.

### 4. Install EBS CSI driver (required for PVC)

```bash
eksctl utils associate-iam-oidc-provider --cluster opensandbox --region <region> --approve

eksctl create iamserviceaccount \
  --name ebs-csi-controller-sa --namespace kube-system \
  --cluster opensandbox --region <region> \
  --attach-policy-arn arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy \
  --approve --role-only --role-name AmazonEKS_EBS_CSI_DriverRole_opensandbox

ROLE_ARN=$(aws iam get-role --role-name AmazonEKS_EBS_CSI_DriverRole_opensandbox \
  --query 'Role.Arn' --output text)

aws eks create-addon --cluster-name opensandbox --addon-name aws-ebs-csi-driver \
  --service-account-role-arn "$ROLE_ARN" --region <region>

# Wait for ACTIVE
aws eks wait addon-active --cluster-name opensandbox \
  --addon-name aws-ebs-csi-driver --region <region>

# Create gp3 StorageClass
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

### 5. Deploy OpenSandbox via Helm

Generate a random API key and save it — you'll need it later:
```bash
OPENSANDBOX_API_KEY=$(openssl rand -hex 32)
echo "OpenSandbox API key: $OPENSANDBOX_API_KEY"
```

```bash
git clone --depth=1 https://github.com/opensandbox-group/OpenSandbox.git /tmp/OpenSandbox
cd /tmp/OpenSandbox/kubernetes

# Package sub-charts (bypasses repo refresh issues)
helm package charts/opensandbox-controller -d charts/opensandbox/charts/
helm package charts/opensandbox-server     -d charts/opensandbox/charts/

kubectl create namespace opensandbox-system

helm install opensandbox charts/opensandbox \
  --namespace opensandbox-system \
  -f - <<EOF
opensandbox-controller:
  controller:
    snapshot:
      containerdSocketPath: ""
opensandbox-server:
  server:
    replicaCount: 1
    resources:
      requests: { cpu: 500m, memory: 512Mi }
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

Wait for both pods to be Running:
```bash
kubectl get pods -n opensandbox-system -w
```

Known issues to watch for:
- Controller in CrashLoopBackOff → check logs for `unknown flag: --containerd-socket-path`.
  If present, the containerdSocketPath fix above didn't apply — re-run helm upgrade with the values.
- Server pods Pending → `kubectl describe pod` will show Insufficient memory if node is too small.

### 6. Build and push opencode-anthropic-server image

```bash
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO=$AWS_ACCOUNT_ID.dkr.ecr.<region>.amazonaws.com/opencode-anthropic-server

aws ecr create-repository --repository-name opencode-anthropic-server --region <region>
aws ecr get-login-password --region <region> | \
  docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.<region>.amazonaws.com


# The Dockerfile is in this template directory (templates/opencode/).
# Build from there — no separate clone needed.
docker build --platform linux/amd64 -t $ECR_REPO:latest <path-to-templates/opencode>
docker push $ECR_REPO:latest
```

### 7. Deploy opencode-anthropic-server

```bash
kubectl create secret generic opencode-server-secrets -n opensandbox-system \
  --from-literal=LITELLM_API_KEY=<litellm-api-key> \
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
          image: $ECR_REPO:latest
          ports:
            - containerPort: 8080
          env:
            - {name: WORKDIR,   value: /tmp/opencode-workspace}
            - {name: DB_PATH,   value: /data/agents.db}
            - name: LITELLM_BASE_URL
              value: <litellm-gateway-url>      # must end in /v1
            - name: LITELLM_MODELS
              value: <model-name>               # e.g. claude-sonnet-4-6
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

Wait for the pod to be 1/1 Ready and the LoadBalancer to get an external hostname:
```bash
kubectl -n opensandbox-system rollout status deployment/opencode-anthropic-server
kubectl -n opensandbox-system get svc opencode-anthropic-server
```

### 8. Verify

```bash
LB=$(kubectl -n opensandbox-system get svc opencode-anthropic-server \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

# Health check
curl -s http://$LB/health
# Expected: {"ok":true,"opencode":true}

# Quick smoke test
AGENT=$(curl -sf -X POST http://$LB/v1/agents \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"test\",\"model\":\"<model-name>\",\"system\":\"You are helpful.\"}")
AGENT_ID=$(echo $AGENT | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

SESSION_ID=$(curl -sf -X POST http://$LB/v1/sessions \
  -H "Content-Type: application/json" \
  -d "{\"agent\":\"$AGENT_ID\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

SSE_LOG=$(mktemp)
curl -sN http://$LB/v1/sessions/$SESSION_ID/events/stream \
  -H "Accept: text/event-stream" > $SSE_LOG &

sleep 1
curl -sf -X POST http://$LB/v1/sessions/$SESSION_ID/events \
  -H "Content-Type: application/json" \
  -d '{"events":[{"type":"user.message","content":"say hello in 5 words"}]}' > /dev/null

for i in $(seq 1 60); do sleep 1; grep -q 'session.status_idle' $SSE_LOG && break; done

python3 -c "
ev=None
for l in open('$SSE_LOG'):
    l=l.strip()
    if l.startswith('event:'): ev=l[6:].strip()
    elif l.startswith('data:') and ev=='agent.message':
        import json
        for b in json.loads(l[5:]).get('content',[]): print(b.get('text',''),end='')
print()
"
```

You should see a 5-word reply. If you do, the stack is working.

## Output for the user

When done, print:
- LoadBalancer URL
- Model name to use
- OpenSandbox API key (remind them to save it)
- Any caveats (e.g. LB DNS takes ~60s to propagate after creation)
```
