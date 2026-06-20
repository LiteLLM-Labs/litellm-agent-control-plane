# Central Repo Ops Scaffold

This example is the LAP-side mirror of the real `central-repo-ops` pilot repo.

It now reflects the recommended adoption shape:

- reuse `github/gh-aw` patterns as the workflow authoring model
- keep CentralRepoOps as the inventory, policy, and coordination layer
- keep LAP as the policy and deep-work sidecar
- avoid inventing a custom workflow system inside LAP

## What is included

```text
docs/examples/central-repo-ops/
├── .github/workflows/
│   ├── dependency-rollout.yml
│   ├── dispatch-worker.yml
│   ├── repo-health-scan.yml
│   └── stale-triage.yml
├── manifests/
│   ├── policies/
│   ├── waves/
│   └── repos.json
├── prompts/
├── scripts/
└── target-repo/.github/workflows/repo-ops-worker.yml
```

## Intended usage

1. Copy this directory into a new private GitHub repository named `central-repo-ops`.
2. Move `target-repo/.github/workflows/repo-ops-worker.yml` into each pilot target repo you want to manage.
3. Replace the sample repos in `manifests/repos.json`.
4. Create a GitHub token or GitHub App installation token and save it as `REPO_OPS_TOKEN`.
5. Keep the first runs in dry-run mode until the repo set and policies feel right.

## First pilot repo

The scaffold now treats the WireAI mobile app workspace at `/Users/bencharney/WireAI Right now Mobile App/` as the first pilot target.

Important:

- the WireAI workspace root is now a local git repo
- the nested `mobile/` history was imported into that root repo
- the intended GitHub slug is `toasterman234/wireai-right-now-mobile-app`
- create that private repository on GitHub before enabling live dispatches

The pilot wave currently includes only this repo so the first control-plane tests stay narrowly scoped.

## Workflow model

- `repo-health-scan.yml` resolves the repo set and emits per-repo artifacts.
- `dependency-rollout.yml` resolves the repo set and dispatches target-repo worker events.
- `stale-triage.yml` does the same for stale-triage operations.
- `dispatch-worker.yml` is a reusable workflow that performs the cross-repo `repository_dispatch` call.

For the first pilot, `repo-health-scan.yml` can also dispatch a `repo-health` operation to the target repo worker when the repo has a real GitHub remote and you turn dispatch on explicitly.

## Manifest model

This scaffold uses JSON rather than YAML so the bundled helper scripts can run with stock Node.js.

- `manifests/repos.json` is the main source of truth
- `manifests/waves/*.json` define rollout waves
- `manifests/policies/*.json` define tier defaults and exceptions
- `manifests/policies/repo-health-profiles.json` defines repo-specific health checks
- `manifests/policies/repo-governance.json` defines baseline repo rules, structure, and formatting expectations

Each repo record declares:

- stable `id`
- GitHub `repo`
- `tier`
- `default_branch`
- enabled state
- labels
- allowed operations

## Safety defaults

- Write-style workflows default `dry_run` to `true`.
- Cross-repo dispatch only happens when `REPO_OPS_TOKEN` is present and `dry_run` is `false`.
- The target worker only echoes intended actions until you replace the placeholder steps with repo-specific automation.

## Repo health for WireAI

The first pilot flow is `repo-health`.

The scaffold includes a WireAI-specific health profile that checks for:

- top-level handoff and readme docs
- Expo mobile config files
- FastAPI bridge requirements
- the split between `mobile/`, `mock-webhook/`, and `phase2-backend/`

Keep repo-health dispatch in dry-run mode until:

- the WireAI app remote exists on GitHub
- the sample worker file has been installed in that target repo

The LAP repo in this workspace already has a real remote:

- `LiteLLM-Labs/litellm-agent-control-plane`

So LAP can use the same repo-health pattern once you want to widen beyond the first pilot wave.

## Next steps

- compile real `gh-aw` lockfiles in the actual `central-repo-ops` repo
- add LAP policy lookup before dispatch if you want central policy mediation
- expand the target worker into repo-local automation once the control-plane shape is validated
