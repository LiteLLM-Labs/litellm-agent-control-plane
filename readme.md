# LiteLLM Agent Platform

Self-hosted UI for creating and running agents on any agent runtime: Claude
Managed Agents, Cursor Agents API, OpenCode Agents, and DeepAgents.

![LiteLLM Agent Platform dashboard](https://github.com/user-attachments/assets/04333758-829c-4b19-bde3-23ade37bb9f1)

LiteLLM Agent Platform sits on top of any runtime. Pick a runtime, create an
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
git clone https://github.com/LiteLLM-Labs/litellm-agent-platform
cd litellm-agent-platform

docker build -t litellm-agent-platform .
DATABASE_URL=postgres://user:password@host.docker.internal:5432/litellm_agents
docker run --rm -p 4000:4000 \
  -e LITELLM_MASTER_KEY=sk-local \
  -e DATABASE_URL="$DATABASE_URL" \
  litellm-agent-platform
```

Open [http://localhost:4000](http://localhost:4000) and sign in with the
master key (`sk-local` in the command above). The container serves the UI and
API from the same process. Add provider credentials in Settings before running
agents against a hosted model provider.

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
- DeepAgents

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
