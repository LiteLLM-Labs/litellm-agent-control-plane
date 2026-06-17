# LiteLLM Agent Control Plane

1 place to call all your agents - OpenCode, Hermes, Claude
Managed Agents, Cursor Agents API, Deep Agents.

[![Discord](https://img.shields.io/badge/Discord-Chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/Nkxw3rm3EE)

![LiteLLM Agent Platform dashboard](https://github.com/user-attachments/assets/04333758-829c-4b19-bde3-23ade37bb9f1)

LiteLLM Agent Control Plane sits on top of any runtime. Pick a runtime, create an
agent, give your team one UI.

It manages:

- **Unified API across runtimes** - one API to create and run agents,
  regardless of the runtime underneath
- **Access** - developers create and run agents here, no Bedrock or Anthropic
  console access required
- **Session management** - persistent agent sessions across runs
- **CRON schedules** - run agents on a schedule
- **Memory** - agents remember context across sessions

## Quick Start

Prerequisite: Docker Desktop.

```bash
docker compose --profile opencode up
```

Open [http://localhost:4000](http://localhost:4000) and sign in with the
master key (`sk-local` by default). Compose starts the LiteLLM Agent Platform
web/API service, a Postgres database, the OpenCode template runtime, and
registers `local-opencode` in the UI automatically.

To start only the base LAP stack:

```bash
docker compose up
```

To start other template runtime profiles and add them to the UI automatically:

```bash
docker compose --profile deepagents up
docker compose --profile hermes up
docker compose --profile openclaw up
docker compose --profile opencode --profile deepagents up
```

Profiles register `local-opencode`, `local-deepagents`, `local-hermes`, and
`local-openclaw`
through the LAP API after the services are healthy. Add provider credentials in
Settings before running agents against a hosted model provider.

## Usage: Create an Agent

### 1. Make an agent in the UI

![Create agent screen](https://github.com/user-attachments/assets/d2083454-b7c1-4337-b2c2-4c4ba99991b6)

### 2. Select tools and skills to connect to your agent

![Select tools and skills](https://github.com/user-attachments/assets/efd59a4e-dcc7-487a-923b-005ac44b44b0)

### 3. Use your agent

Select your agent and the runtime you want to run it on.

![Run agent on a runtime](https://github.com/user-attachments/assets/be9cfd8c-4475-4309-bed0-4edcd7dd1de1)

## Supported Agent Runtimes

- Claude Managed Agents
- Cursor Agents API
- OpenCode Agents
- OpenClaw Agents
- Deep Agents
- Hermes Agent

## Contributing

PRs welcome. See [docs/engineering/contributing.mdx](docs/engineering/contributing.mdx).
