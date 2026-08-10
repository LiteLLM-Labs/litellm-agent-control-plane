# Deploy the Codex runtime on EKS

Build and push the image to ECR, then deploy one replica with persistent volumes
mounted at `/data` and `/codex-home`. Set `MODEL_BASE_URL`, `MODEL_API_KEY`,
`DEFAULT_MODEL`, `RUNTIME_API_KEY`, and a stable `PROFILE_ENCRYPTION_KEY` from
Kubernetes Secrets. Expose port 8080
through a ClusterIP Service and configure readiness and liveness probes for
`GET /health`.

Run one replica per persistent volume. SQLite and the Codex thread directory are
durable local state and must not be mounted read-write by multiple pods. For
horizontal scaling, give each pod its own volumes and use session-affine routing,
or replace the local store with a shared transactional store before scaling.

Register the Service URL in LAP with API spec `claude_managed_agents`. Keep the
runtime API key distinct from the upstream model key, and apply a NetworkPolicy
that permits only LAP ingress and the configured model, OpenAI authorization,
and approved SSH endpoints as egress. ChatGPT tokens, profile configuration,
and profile session databases live below `/data`; preserve that volume across
rollouts.
