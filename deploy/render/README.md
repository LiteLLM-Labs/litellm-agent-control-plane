# Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/BerriAI/litellm-agent-platform)

One click. Render reads [`render.yaml`](../../render.yaml) and creates:

| Resource         | Type                        |
|------------------|-----------------------------|
| Postgres         | Render managed Postgres     |
| `litellm-agents-web`    | Render Web Service   |
| `litellm-agents-worker` | Render Background Worker |

`MASTER_KEY` is auto-generated. `DATABASE_URL` is wired automatically.

## You provide

After Render finishes provisioning, fill these on the dashboard
(`Environment` tab, both web + worker — or use Render env groups):

| Var                  | Source                                                      |
|----------------------|-------------------------------------------------------------|
| `LITELLM_API_BASE`   | OpenAI-compatible `/chat/completions` endpoint (LiteLLM Cloud, your own LiteLLM proxy — anything that speaks OpenAI's wire format) |
| `LITELLM_API_KEY`    | API key for the above                                       |
| `KUBE_CONFIG_B64`    | base64-encoded kubeconfig for your sandbox cluster          |
| `K8S_NODE_HOST`      | node IP / LB hostname Render egress can reach               |
| `K8S_HARNESS_IMAGE`  | registry path of `opencode-sandbox:<tag>` your cluster pulls |

The platform never proxies the model itself — it just forwards
`/chat/completions` calls through `LITELLM_API_BASE`. Use `litellm.ai`
hosted, or run `ghcr.io/berriai/litellm:main-stable` anywhere.

## Sandbox cluster

Render does not host Kubernetes. Provision one elsewhere and bring the
kubeconfig:

| Cloud | Script                                              |
|-------|-----------------------------------------------------|
| AWS   | [`bin/eks-up.sh`](../../bin/eks-up.sh) — see [`../aws/`](../aws/) |
| GCP   | (similar GKE script — see [`../gcp/`](../gcp/))     |
| Other | install [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) on any cluster, then `kubectl config view --minify --flatten | base64` |

## Gotchas

- **Egress is unpinned.** If your cluster apiserver / NodePort range is
  IP-allowlisted, buy Render's static-egress add-on or front the cluster
  with a public LB.
- **Kubeconfig token rotation.** Short-lived tokens (`aws eks get-token`)
  won't work — bake a static service-account token into the kubeconfig
  before encoding.
- **First deploy will fail until you fill the `sync: false` vars.** That's
  expected — Render kicks off a build immediately, redeploy after pasting.
