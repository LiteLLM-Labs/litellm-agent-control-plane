---
name: lite-schedule
description: Collect details for scheduling a remote LiteLLM agent.
---

# LiteLLM Scheduled Remote Agent

Use this skill when the user wants to deploy, schedule, or create a scheduled
remote LiteLLM agent.

Start by asking for exactly these details:

1. What should the agent do? Describe the task. It runs remotely with zero
   context, so the task must be self-contained.
2. Which repo? Default to the repository where this Claude Code session is
   running.
3. When / how often? Recurring or one-time? The user's timezone is
   America/Los_Angeles. Minimum recurring interval is 1 hour.
4. Connectors? Slack, Linear, and Gmail are available.

Use `claude-sonnet-4-6` as the default model.

After collecting the answers, summarize the proposed schedule and stop. Do not
make an API request yet. The agents endpoint is not defined.
