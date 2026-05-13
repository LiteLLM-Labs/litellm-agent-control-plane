# vault

Sidecar that holds an agent's real secrets and swaps stub values for real
ones at HTTPS egress. The agent process never sees the real token.

## Why this exists

LiteLLM Agent Platform runs arbitrary agent code in a sandboxed pod. The
agent needs credentials — a GitHub token, an Anthropic key, a Slack
webhook — to do useful work. The naïve approach is to inject those
credentials directly into the agent container's env. Two problems with
that:

1. Any tool, dependency, or model invocation inside the harness can read
   the env and exfiltrate it (intentionally or via prompt injection).
2. A token that leaks once is a token that's gone — rotation across many
   agents is painful.

vault solves (1). The agent container only ever holds opaque
**stubs** (`stub_github_token_a7f3`). The real values live in a sibling
sidecar container in the same pod. When the agent makes any outbound
HTTPS call, the request is funneled through the sidecar, which swaps the
stub for the real secret in headers and bodies, then forwards to the
upstream.

If the agent dumps its env, attaches it to a chat message, or writes it
to disk, only the stub leaks. The stub by itself is worthless to anyone
outside the sidecar.

## Threat model

**What this protects against:** the agent process (and anything it
shells out to — `gh`, `git`, `curl`, `python`, the bundled Claude
binary) reading the real secret. The harness env never contains the
real value; the disk never contains it; even `printenv` returns the
stub.

**What this does NOT protect against:** the agent exfiltrating the
stub. Whatever endpoint the agent talks to that receives a stub will
have the stub swapped for the real value by the sidecar before the
bytes leave the pod. If the agent is malicious and sends a stub to an
attacker-controlled URL whitelist'd into outbound traffic, the attacker
gets a real token. The defense for that is upstream-host allowlisting,
which is a separate layer (egress firewall / NetworkPolicy).

The threat model here is **untrusted agent code in a sandboxed
process**, not **fully sandboxed enclave with hostile network peers**.

## Flow

```
  ┌───────────────────────────────────────────────────────────┐
  │                       Sandbox Pod                         │
  │                                                           │
  │  ┌───────────────────┐         ┌──────────────────────┐   │
  │  │ harness container │         │   vault sidecar      │   │
  │  │                   │         │                      │   │
  │  │  env:             │  TLS    │  REAL_GITHUB_TOKEN=  │   │
  │  │   GITHUB_TOKEN=   │  CONNECT│    ghp_<actual>      │   │
  │  │    stub_github_…  │ ──────▶ │                      │ ──┼──▶ github.com
  │  │                   │  127.0  │  MITMs, swaps        │   │     (sees real
  │  │  Authorization:   │  .0.1:  │  stub→real in:       │   │      ghp_<actual>)
  │  │   Bearer stub_…   │  14322  │   - headers          │   │
  │  │                   │         │   - text/JSON bodies │   │
  │  │  HTTPS_PROXY=     │         │                      │   │
  │  │   127.0.0.1:14322 │         │  Re-encrypts with    │   │
  │  └───────────────────┘         │  per-host leaf cert  │   │
  │                                └──────────────────────┘   │
  │                                                           │
  │   shared volume /lap-shared:                              │
  │     env  ← stub map (harness sources this at boot)        │
  └───────────────────────────────────────────────────────────┘
```

The harness sees **stubs flowing left-to-right** (out of its own
process). The upstream sees **real values flowing right-to-left** (out
of the pod, after the sidecar has done the swap). The sidecar is the
only point in the system where both halves coexist.

## The CA

The sidecar terminates every outbound TLS connection from the harness
(it has to, in order to read and rewrite headers and bodies). For the
harness to trust those terminated connections, the sidecar mints
per-host leaf certs signed by a CA that the harness trusts.

We use **one cluster-level CA**, not a per-pod CA:

- **Public cert** is at [`harnesses/vault/ca.crt`](./ca.crt) and is
  **baked into every harness image at build time**. See
  [`harnesses/claude-agent-sdk/Dockerfile`](../claude-agent-sdk/Dockerfile)
  — it copies `ca.crt` into `/etc/ssl/certs/`, runs
  `update-ca-certificates`, and appends it to the OpenSSL bundle. This
  way every TLS client in the image trusts the sidecar before the
  container even starts.
- **Private key** lives in a K8s Secret named `vault-ca` (type
  `kubernetes.io/tls`), mounted at `/etc/vault-ca/tls.key` **only into
  the sidecar container**. The harness container has no mount for it.
- **Leaf issuance** is on-demand: when the harness opens a TLS
  connection to `github.com`, the sidecar mints a short-lived leaf
  with `CN=github.com` and the matching SAN, signed by the CA. See
  [`src/ca.ts`](./src/ca.ts) `issueLeaf()`.

### Why baked-in, not per-pod

The obvious alternative is "generate a fresh CA per pod, drop the cert
into a shared volume, point the harness's `NODE_EXTRA_CA_CERTS` at
it." We tried that first. Two reasons it doesn't work:

1. The bundled `claude` native binary in the Claude Agent SDK harness
   does not honor `NODE_EXTRA_CA_CERTS`. It compiles a CA bundle in
   and ignores env overrides. We'd need to LD_PRELOAD or repack the
   binary.
2. Debian's `git` is linked against `libcurl-gnutls`, which discovers
   trust via `/etc/ssl/certs/<hash>.0` hash symlinks, not the bundle
   file. Per-pod CA generation has to write into `/etc/ssl/certs/`
   anyway and rebuild the hash links — at which point it's the same
   amount of work as baking the CA in, but slower and racy.

Baking the CA into the image at build time sidesteps both. The cost
is that we need to rotate the CA via image rebuild, not via a K8s
secret update. That's a tradeoff we're fine with at this scale.

### gnutls AKI requirement

`libcurl-gnutls` enforces stricter chain-validation than OpenSSL: it
requires the leaf to carry an `AuthorityKeyIdentifier` extension that
matches the CA's `SubjectKeyIdentifier`. OpenSSL tolerates the leaf
omitting AKI; gnutls rejects with `certificate signer not found`. The
sidecar adds both SKI (on the CA) and AKI (on each leaf) — see
`issueLeaf()` in [`src/ca.ts`](./src/ca.ts).

## Stub minting

On startup, the sidecar reads every env var named `REAL_<KEY>` (e.g.
`REAL_GITHUB_TOKEN`), mints a stub like `stub_github_token_a7f3`, and
writes `KEY=stub_…` lines to `/lap-shared/env`. The harness entrypoint
([`harnesses/claude-agent-sdk/entrypoint.sh`](../claude-agent-sdk/entrypoint.sh))
sources that file, so by the time the agent runs, its env contains
only stubs.

Ordering matters: the sidecar writes `/lap-shared/env` **after** the
HTTPS proxy is listening on 127.0.0.1:14322. The harness blocks until
the file exists, so it's guaranteed the proxy is ready by the time
the agent makes its first outbound call.

## Swap mechanics

The interception logic is intentionally small — see
[`src/intercept.ts`](./src/intercept.ts). For every text-like response
body (JSON, form-encoded, ndjson, XML, plain text) and every header,
the sidecar does a literal `String.prototype.split(stub).join(real)`
replacement. Binary bodies are passed through untouched. There's no
parsing — if the stub appears, it's swapped.

This is robust to whatever encoding the agent picks (Bearer header,
form body, JSON body, query string — all just text). It does mean
that if a stub happens to appear inside an unrelated string in a body,
it gets swapped — but stubs are 8 hex chars of entropy past a fixed
prefix, so collisions are vanishingly unlikely.

## Deployment

The sidecar is wired in by
[`src/server/k8s.ts`](../../src/server/k8s.ts). Every Sandbox pod gets
the vault container automatically, with `REAL_*` env vars built from
the agent's encrypted `env_vars` column.

### Cluster prerequisite

The cluster must have a Secret named `vault-ca` of type
`kubernetes.io/tls`, containing the CA cert + matching private key:

```bash
openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
  -keyout tls.key -out tls.crt \
  -subj "/CN=vault/O=LiteLLM" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

kubectl create secret tls vault-ca \
  --cert=tls.crt --key=tls.key \
  -n <sandbox-namespace>
```

The `tls.crt` from this step must match
[`harnesses/vault/ca.crt`](./ca.crt) in this repo (the baked-in
public copy). They are the same cert, deployed in two places:

- Public half checked into the repo → baked into the harness image
  at build time.
- Public + private halves in the K8s secret → mounted into the
  sidecar at runtime.

To rotate the CA: regenerate the cert + key, replace `ca.crt` in the
repo, rebuild harness images, update the K8s secret. The rotation is
not online — there's a window where pods scheduled before the rebuild
will have the old cert.

> **Migration note.** Older deployments had this secret named
> `lap-vault-ca` and mounted at `/etc/lap-vault-ca/`. The codebase
> now expects `vault-ca` and `/etc/vault-ca/`. Rename the secret in
> the live cluster (`kubectl get secret lap-vault-ca -o yaml | sed
> 's/lap-vault-ca/vault-ca/g' | kubectl apply -f - && kubectl delete
> secret lap-vault-ca`) when deploying this change.

## Files

- [`src/server.ts`](./src/server.ts) — HTTPS CONNECT proxy, listens on
  `127.0.0.1:14322`, MITMs each TLS connection, runs swap, forwards.
- [`src/ca.ts`](./src/ca.ts) — loads the CA from the mounted secret,
  issues per-host leaves on demand, caches them by host.
- [`src/intercept.ts`](./src/intercept.ts) — stub→real string swap.
- [`ca.crt`](./ca.crt) — public CA cert, baked into the harness image.
- [`Dockerfile`](./Dockerfile) — multi-stage build, runs as
  `node dist/server.js`.
