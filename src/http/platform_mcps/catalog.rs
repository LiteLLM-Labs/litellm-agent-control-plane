use serde::Serialize;

use super::{
    AGENT_MEMORY_MCP_ID, CHECK_HUMAN_APPROVAL_MCP_ID, CONNECT_AGENT_TO_SLACK_MCP_ID,
    CREATE_MANAGED_AGENT_MCP_ID, EDIT_AGENT_SKILL_MCP_ID, LIST_SLACK_AGENT_BINDINGS_MCP_ID,
    LIST_SUB_AGENTS_MCP_ID, PLATFORM_SESSION_MCP_ID, REQUEST_HUMAN_APPROVAL_MCP_ID,
    RUN_SUB_AGENT_MCP_ID, SEND_PLATFORM_SESSION_MESSAGE_MCP_ID, SEND_SLACK_MESSAGE_MCP_ID,
};

#[derive(Debug, Clone, Copy, Serialize)]
pub struct PlatformMcp {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
}

pub fn platform_mcps() -> Vec<PlatformMcp> {
    CATALOG.to_vec()
}

const CATALOG: &[PlatformMcp] = &[
    PlatformMcp {
        id: PLATFORM_SESSION_MCP_ID,
        name: "Read platform session",
        description: "Read persisted platform session messages for debugging and handoff.",
    },
    PlatformMcp {
        id: SEND_PLATFORM_SESSION_MESSAGE_MCP_ID,
        name: "Send platform session message",
        description: "Send a user message into a platform session and resume that agent run.",
    },
    PlatformMcp {
        id: AGENT_MEMORY_MCP_ID,
        name: "Read/Write agent memory",
        description: "List, read, and update DB-backed memory for a platform agent.",
    },
    PlatformMcp {
        id: EDIT_AGENT_SKILL_MCP_ID,
        name: "Edit agent skill",
        description: "List, read, and update DB-backed skills attached to this agent.",
    },
    PlatformMcp {
        id: SEND_SLACK_MESSAGE_MCP_ID,
        name: "Send Slack message",
        description: "Send a channel message or DM from this agent's connected Slack bot.",
    },
    PlatformMcp {
        id: CREATE_MANAGED_AGENT_MCP_ID,
        name: "Create managed agent",
        description: "Create a Claude managed agent from a Slack or platform request.",
    },
    PlatformMcp {
        id: CONNECT_AGENT_TO_SLACK_MCP_ID,
        name: "Connect agent to Slack",
        description: "Create a dedicated Slack app for a managed agent and return its install URL.",
    },
    PlatformMcp {
        id: LIST_SLACK_AGENT_BINDINGS_MCP_ID,
        name: "List Slack agent bindings",
        description: "List channel bindings created by this platform agent factory.",
    },
    PlatformMcp {
        id: LIST_SUB_AGENTS_MCP_ID,
        name: "List sub-agents",
        description: "List this agent's attached LAP sub-agents with IDs, names, and runtime.",
    },
    PlatformMcp {
        id: RUN_SUB_AGENT_MCP_ID,
        name: "Run sub-agent",
        description:
            "Run one of this agent's explicitly attached LAP sub-agents and return its session.",
    },
    PlatformMcp {
        id: REQUEST_HUMAN_APPROVAL_MCP_ID,
        name: "Request human approval",
        description: "File an async operator approval request in the managed agent inbox.",
    },
    PlatformMcp {
        id: CHECK_HUMAN_APPROVAL_MCP_ID,
        name: "Check human approval",
        description: "Check the current decision state for a filed approval request.",
    },
];
