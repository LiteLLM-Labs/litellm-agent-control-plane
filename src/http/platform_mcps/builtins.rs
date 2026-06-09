use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db::managed_agents::{memory, messages, registry, sessions},
    errors::GatewayError,
};

use super::{required_str, AGENT_MEMORY_MCP_ID, PLATFORM_SESSION_MCP_ID};

pub fn tool_defs() -> Vec<Value> {
    vec![
        json!({
            "name": PLATFORM_SESSION_MCP_ID,
            "description": "Read persisted platform session messages by session_id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": { "type": "string" }
                },
                "required": ["session_id"]
            }
        }),
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
        }),
    ]
}

pub async fn read_platform_session(pool: &PgPool, arguments: Value) -> Result<Value, GatewayError> {
    let session_id = required_str(&arguments, "session_id")?;
    let session = sessions::repository::get(pool, session_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound("session not found".to_owned()))?;
    let rows = messages::repository::list(pool, session_id).await?;
    Ok(json!({
        "session": session,
        "messages": rows.into_iter().map(|row| {
            json!({
                "id": row.id,
                "seq": row.seq,
                "info": serde_json::from_str::<Value>(&row.info_json).unwrap_or(Value::String(row.info_json)),
                "parts": serde_json::from_str::<Value>(&row.parts_json).unwrap_or(Value::String(row.parts_json))
            })
        }).collect::<Vec<_>>()
    }))
}

pub async fn agent_memory(
    pool: &PgPool,
    agent_id: &str,
    arguments: Value,
) -> Result<Value, GatewayError> {
    if registry::repository::get(pool, agent_id).await?.is_none() {
        return Err(GatewayError::UnknownAgent(agent_id.to_owned()));
    }
    match required_str(&arguments, "action")? {
        "list" => Ok(json!({ "memories": memory::repository::list(pool, agent_id).await? })),
        "get" => {
            let key = required_str(&arguments, "key")?;
            let row = memory::repository::list(pool, agent_id)
                .await?
                .into_iter()
                .find(|row| row.key == key);
            Ok(json!({ "memory": row }))
        }
        "set" => {
            let key = required_str(&arguments, "key")?.to_owned();
            let value = required_str(&arguments, "value")?.to_owned();
            let always_on = arguments.get("always_on").and_then(Value::as_bool);
            Ok(json!({
                "memory": memory::repository::store(pool, agent_id, key, value, always_on).await?
            }))
        }
        action => Err(GatewayError::InvalidJsonMessage(format!(
            "unsupported memory action: {action}"
        ))),
    }
}
