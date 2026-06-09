use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db::managed_agents::{
        inbox::{self, schema::InboxItemRow},
        registry,
    },
    errors::GatewayError,
};

use super::required_str;

pub async fn request_human_approval(
    pool: &PgPool,
    agent_id: &str,
    session_id: Option<&str>,
    arguments: Value,
) -> Result<Value, GatewayError> {
    let title = required_str(&arguments, "title")?.to_owned();
    let agent = registry::repository::get(pool, agent_id)
        .await?
        .ok_or_else(|| GatewayError::UnknownAgent(agent_id.to_owned()))?;
    let item = inbox::repository::create_approval(
        pool,
        title,
        session_id
            .map(str::to_owned)
            .or_else(|| optional_str(&arguments, "session_id")),
        Some(agent.name),
        optional_str(&arguments, "body"),
        arguments.get("arguments").cloned(),
    )
    .await?;
    Ok(approval_payload(item))
}

pub async fn check_human_approval(pool: &PgPool, arguments: Value) -> Result<Value, GatewayError> {
    let approval_id = required_str(&arguments, "approval_id")?;
    let Some(item) = inbox::repository::get(pool, approval_id).await? else {
        return Ok(json!({
            "approval_id": approval_id,
            "status": "missing"
        }));
    };
    Ok(approval_payload(item))
}

fn approval_payload(item: InboxItemRow) -> Value {
    json!({
        "approval_id": item.id,
        "status": item.status,
        "session_id": item.session_id,
        "feedback": item.feedback,
        "arguments": parse_args(item.args_json),
        "message": if item.status == "pending" {
            Some("approval is pending in the inbox")
        } else {
            None
        }
    })
}

fn optional_str(arguments: &Value, field: &str) -> Option<String> {
    arguments
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn parse_args(args_json: Option<String>) -> Value {
    args_json
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_else(|| json!({}))
}
