# Deployment

How to run litellm-rust locally and deploy it (UI + API) to a host like Render.

## What you need

- A LiteLLM-style `config.yaml` (`model_list` + `general_settings`).
- A gateway master key (`LITELLM_MASTER_KEY`) — clients authenticate with it via
  `Authorization: Bearer <key>` or `x-api-key`. It also encrypts stored creds.
- A **Postgres database** (`DATABASE_URL`) — required for provider credentials
  and the sessions/agents UI.

Config values can reference env vars with `os.environ/NAME`. **Every referenced
env var must be set at boot or startup fails.** Keep hosted configs minimal — see
[`deploy/render.config.yaml`](deploy/render.config.yaml).

### Provider credentials live in the database, not the config

Do **not** put provider API keys in `config.yaml` / env vars. Add them through
the **Settings UI** (`/settings`) or the API — they are stored encrypted in the
DB and injected per request:

```bash
curl -X POST $BASE/api/providers/anthropic \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H "content-type: application/json" \
  -d '{"api_key":"sk-ant-...","api_base":"https://api.anthropic.com"}'
```

A model route with no `api_key` is valid **as long as a database is configured**
(the key comes from the DB). Today only **anthropic** is in the credential
catalog; other providers need a catalog entry before they can be DB-backed.

> **One wildcard only.** The router supports exactly one `provider/*` wildcard
> route. Reserve it for your primary provider (e.g. `anthropic/*`) and list other
> providers' models explicitly. Two wildcards fail boot with
> `only one wildcard model route is supported`.

## Run locally

```bash
# from source
cargo run --release -- serve --config config.yaml --host 0.0.0.0 --port 4000

# or with Docker (builds UI + binary, serves both)
docker build -t litellm-rust .
docker run --rm -p 4000:4000 \
  -e LITELLM_MASTER_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e OPENAI_API_KEY=sk-... \
  litellm-rust
```

`HOST`, `PORT`, `LITELLM_CONFIG`, and `LITELLM_UI_DIR` are read from the
environment (the Dockerfile sets sensible defaults). The UI is served from
`LITELLM_UI_DIR`; the API routes live alongside it (see [Routes](README.md#routes)).

## Deploy to Render

The repo ships a multi-stage [`Dockerfile`](Dockerfile) (Next.js UI + Rust
binary) and a boot-safe [`deploy/render.config.yaml`](deploy/render.config.yaml)
baked to `/app/deploy.config.yaml`.

Create a **Web Service** (Docker) from this repo:

| Setting | Value |
| --- | --- |
| Runtime / Environment | Docker |
| Dockerfile path | `./Dockerfile` |
| Docker command | `lite serve --config /app/deploy.config.yaml` |
| Health check path | `/health` |
| Branch | `main` |

Add a **Postgres** instance and set these as service env vars (secrets):

- `LITELLM_MASTER_KEY` — gateway auth key (also encrypts stored creds)
- `DATABASE_URL` — Postgres connection string (provider creds + sessions UI)

Provider API keys are **not** env vars — add them in the Settings UI after the
service is up (see [Provider credentials](#provider-credentials-live-in-the-database-not-the-config)).
The hosted `gpt-5.5` route uses the OpenAI provider credentials stored in the
database.

Render injects `PORT`; `lite serve` reads it from the env (`HOST=0.0.0.0` is set
in the image), so no port flags are needed in the command.

### Verify the deploy

```bash
BASE=https://<your-service>.onrender.com
KEY=$LITELLM_MASTER_KEY

curl -s $BASE/health                                   # {"status":"ok"}
curl -s $BASE/v1/models -H "Authorization: Bearer $KEY" # configured models

# /v1/messages (Anthropic)
curl -s $BASE/v1/messages -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"anthropic/claude-sonnet-4-5","max_tokens":32,
       "messages":[{"role":"user","content":"Reply with exactly: ok"}]}'

# /v1/responses (Codex)
curl -s $BASE/v1/responses -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"gpt-5.5","input":"Reply with exactly: ok",
       "max_output_tokens":32}'
```

### Gotchas (field-tested)

- **`onrender.com` subdomain is fixed at creation.** Renaming a service changes
  its name but **not** its URL. To change the subdomain, create a new service
  with the desired name.
- **Docker command runs through a shell.** Use a plain command
  (`lite serve --config /app/deploy.config.yaml`) — do not wrap it in your own
  `sh -c '...'`, which Render double-wraps into a single bogus token (exit 127).
- **Build context.** Anything `include_str!`'d at compile time (e.g.
  `skills/lite-schedule.md`) and the config must be COPYed in the Dockerfile, or
  the build/boot fails.
