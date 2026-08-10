# EKS deployment prompt

Deploy `templates/codex` to EKS. Build and push its Docker image, provision
single-writer persistent volumes for `/data` and `/codex-home`, and store the
model and runtime credentials in Kubernetes Secrets. Configure port 8080,
`/health` probes, resource limits, restricted LAP-only ingress, and egress to the
configured model endpoint. Register the resulting internal Service URL in LAP
as a `claude_managed_agents` runtime. Run `scripts/smoke.sh` through the Service
and report the exact image digest, deployment status, and smoke-test result.
