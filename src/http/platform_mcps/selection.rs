use serde_json::Value;

use super::{
    platform_mcps, CHECK_HUMAN_APPROVAL_MCP_ID, LIST_SUB_AGENTS_MCP_ID,
    REQUEST_HUMAN_APPROVAL_MCP_ID, RUN_SUB_AGENT_MCP_ID,
};

pub fn selected_platform_mcp_ids(config: &Value) -> Vec<String> {
    let mut ids: Vec<String> = config
        .get("platform_mcp_ids")
        .or_else(|| config.get("platformMcpIds"))
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .filter(|id| platform_mcps().iter().any(|mcp| mcp.id == *id))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if !sub_agent_ids(config).is_empty() {
        if !ids.iter().any(|id| id == LIST_SUB_AGENTS_MCP_ID) {
            ids.push(LIST_SUB_AGENTS_MCP_ID.to_owned());
        }
        if !ids.iter().any(|id| id == RUN_SUB_AGENT_MCP_ID) {
            ids.push(RUN_SUB_AGENT_MCP_ID.to_owned());
        }
    }
    if ids.iter().any(|id| id == REQUEST_HUMAN_APPROVAL_MCP_ID)
        && !ids.iter().any(|id| id == CHECK_HUMAN_APPROVAL_MCP_ID)
    {
        ids.push(CHECK_HUMAN_APPROVAL_MCP_ID.to_owned());
    }
    ids
}

pub fn sub_agent_ids(config: &Value) -> Vec<String> {
    config
        .get("sub_agents")
        .or_else(|| config.get("subAgents"))
        .and_then(Value::as_array)
        .map(|agents| {
            agents
                .iter()
                .filter_map(|agent| {
                    agent
                        .get("agent_id")
                        .or_else(|| agent.get("agentId"))
                        .or_else(|| agent.get("id"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default()
}
