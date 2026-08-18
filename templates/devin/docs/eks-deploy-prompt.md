# EKS deploy prompt — Devin Managed Agents server

Paste this entire block into Claude Code (or any capable coding agent). It will
deploy the devin-agent-server stack to EKS end-to-end, asking you for whatever it
needs and verifying the result.

```text
Deploy the devin-agent-server stack to an EKS cluster.

What it is: a Node.js Express server that exposes the Devin CLI
(https://devin.ai/cli) behind the Anthropic Managed Agents API spec, so the
LiteLLM Agent Platform (LAP) can drive Devin as a `claude_managed_agents`
runtime. The server spawns `devin acp` as a child process and speaks the Agent
Client Protocol (ACP, JSON-RPC over stdio) to it. Model calls route through the
Devin account credentials — there is no LiteLLM gateway wiring for model calls.

Follow the deployment guide at:
https://github.com/LiteLLM-Labs/litellm-agent-control-plane/blob/main/templates/devin/docs/eks-deployment.md

Work through every step. Ask me for anything you need (AWS credentials, region,
container registry, Devin credentials — either WINDSURF_API_KEY or a host that
has run `devin auth login`). Do not guess.

Requirements before reporting done:
1. The Deployment and Service are Running and Healthy.
2. `curl http://<service>/health` returns {"ok":true,"devin":true}.
3. `curl http://<service>/v1/models` returns an OpenAI-shaped model list with at
   least one model id.
4. Run templates/devin/scripts/smoke.sh against the service and report the
   captured SSE events. If Devin is not yet authenticated on the host, say so
   explicitly and stop — do not pretend the prompt round-trip succeeded.
5. Tell me the exact LAP runtime registration values (API spec, API base) to
   enter in the LAP UI.
```
