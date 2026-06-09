use serde_json::{json, Value};

use super::{
    factory, session_management, AGENT_MEMORY_MCP_ID, CHECK_HUMAN_APPROVAL_MCP_ID,
    EDIT_AGENT_SKILL_MCP_ID, LIST_SUB_AGENTS_MCP_ID, REQUEST_HUMAN_APPROVAL_MCP_ID,
    RUN_SUB_AGENT_MCP_ID, SEND_SLACK_MESSAGE_MCP_ID,
};

pub fn tool_defs() -> Vec<Value> {
    let mut tools = vec![
        session_management::read_tool_def(),
        session_management::send_tool_def(),
        agent_memory_tool(),
        edit_agent_skill_tool(),
        send_slack_message_tool(),
        list_sub_agents_tool(),
        run_sub_agent_tool(),
        request_human_approval_tool(),
        check_human_approval_tool(),
    ];
    tools.extend(factory::tool_defs());
    tools
}

fn request_human_approval_tool() -> Value {
    json!({
        "name": REQUEST_HUMAN_APPROVAL_MCP_ID,
        "description": "Create an async human approval request in the Agent Inbox. This call returns immediately with a pending approval_id; continue other safe work or call check_human_approval later.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Short approval title shown in the inbox."
                },
                "body": {
                    "type": "string",
                    "description": "Context, risk, and exact action the human should review."
                },
                "session_id": {
                    "type": "string",
                    "description": "Optional LAP session ID so the inbox item can link back to the conversation."
                },
                "arguments": {
                    "type": "object",
                    "description": "Optional structured action arguments the human may edit before approving."
                }
            },
            "required": ["title"]
        }
    })
}

fn check_human_approval_tool() -> Value {
    json!({
        "name": CHECK_HUMAN_APPROVAL_MCP_ID,
        "description": "Check whether a previously filed human approval request is pending, accepted, rejected, or missing.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "approval_id": {
                    "type": "string",
                    "description": "Approval ID returned by request_human_approval."
                }
            },
            "required": ["approval_id"]
        }
    })
}

fn list_sub_agents_tool() -> Value {
    json!({
        "name": LIST_SUB_AGENTS_MCP_ID,
        "description": "List this parent agent's attached LAP sub-agents, including each agent_id, name, description, model, and runtime. Call this before run_sub_agent when choosing by name.",
        "inputSchema": {
            "type": "object",
            "properties": {}
        }
    })
}

fn run_sub_agent_tool() -> Value {
    json!({
        "name": RUN_SUB_AGENT_MCP_ID,
        "description": "Run one of this agent's configured LAP sub-agents. Only agent IDs attached to this parent agent are allowed. Use list_sub_agents first when you need the attached agents' names.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "agent_id": {
                    "type": "string",
                    "description": "The LAP agent ID from this parent agent's sub_agents list."
                },
                "prompt": {
                    "type": "string",
                    "description": "The complete task, context, paths, and expected output for the sub-agent."
                },
                "title": {
                    "type": "string",
                    "description": "Optional session title."
                }
            },
            "required": ["agent_id", "prompt"]
        }
    })
}

fn agent_memory_tool() -> Value {
    json!({
        "name": AGENT_MEMORY_MCP_ID,
        "description": "List, read, or update DB-backed memory for this platform agent.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["list", "get", "set"] },
                "key": { "type": "string" },
                "value": { "type": "string" },
                "always_on": { "type": "boolean" }
            },
            "required": ["action"]
        }
    })
}

fn edit_agent_skill_tool() -> Value {
    json!({
        "name": EDIT_AGENT_SKILL_MCP_ID,
        "description": "List, read, or update DB-backed skills attached to this agent. Updates are limited to this agent's own attached skill_ids.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["list", "get", "update"] },
                "skill_id": {
                    "type": "string",
                    "description": "Attached skill ID. May be omitted for get/update only when exactly one skill is attached."
                },
                "name": { "type": "string" },
                "description": { "type": "string" },
                "content": {
                    "type": "string",
                    "description": "Full replacement markdown content for the skill."
                }
            },
            "required": ["action"]
        }
    })
}

fn send_slack_message_tool() -> Value {
    json!({
        "name": SEND_SLACK_MESSAGE_MCP_ID,
        "description": "Send a Slack channel message or DM using this agent's connected Slack bot.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "channel_id": {
                    "type": "string",
                    "description": "Slack channel ID, such as C123. When omitted, sends a DM."
                },
                "user_id": {
                    "type": "string",
                    "description": "Slack user ID, such as U123. Used for DMs only."
                },
                "email": {
                    "type": "string",
                    "description": "Slack user email. Used for DMs when user_id is omitted."
                },
                "text": { "type": "string" }
            },
            "required": ["text"]
        }
    })
}
