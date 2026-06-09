use std::sync::Arc;

use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db::managed_agents::{messages, sessions},
    errors::GatewayError,
    proxy::state::AppState,
};

use super::{required_str, PLATFORM_SESSION_MCP_ID, SEND_PLATFORM_SESSION_MESSAGE_MCP_ID};

pub fn read_tool_def() -> Value {
    json!({
        "name": PLATFORM_SESSION_MCP_ID,
        "description": "Read persisted platform session messages by session_id.",
        "inputSchema": {
            "type": "object",
            "properties": { "session_id": { "type": "string" } },
            "required": ["session_id"]
        }
    })
}

pub fn send_tool_def() -> Value {
    json!({
        "name": SEND_PLATFORM_SESSION_MESSAGE_MCP_ID,
        "description": "Send a user message into a platform session by session_id and resume the target agent run.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": { "type": "string" },
                "text": { "type": "string" },
                "model_id": {
                    "type": "string",
                    "description": "Optional model ID for non-runtime harness sessions."
                }
            },
            "required": ["session_id", "text"]
        }
    })
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

pub async fn send_platform_session_message(
    state: Arc<AppState>,
    pool: PgPool,
    arguments: Value,
) -> Result<Value, GatewayError> {
    let session_id = required_str(&arguments, "session_id")?.to_owned();
    let text = required_str(&arguments, "text")?.to_owned();
    let model = model_id(&arguments);
    crate::http::sessions::enqueue_prompt_text(state, pool.clone(), &session_id, text, model)
        .await?;

    let session = sessions::repository::get(&pool, &session_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound("session not found".to_owned()))?;
    Ok(json!({
        "session_id": session.id,
        "status": session.status,
        "runtime": session.runtime,
        "provider_run_id": session.provider_run_id
    }))
}

fn model_id(arguments: &Value) -> String {
    arguments
        .get("model_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("claude-sonnet-4-6")
        .to_owned()
}
