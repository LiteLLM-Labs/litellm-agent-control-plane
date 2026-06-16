use serde_json::Value;
use sqlx::PgPool;

use crate::{db::managed_agents::messages, errors::GatewayError};

pub(crate) async fn last_message_seq(pool: &PgPool, session_id: &str) -> Result<i32, GatewayError> {
    let rows = messages::repository::list(pool, session_id).await?;
    Ok(rows.into_iter().map(|row| row.seq).max().unwrap_or(0))
}

pub(crate) async fn persisted_assistant_text_after(
    pool: &PgPool,
    session_id: &str,
    baseline_seq: i32,
) -> Result<Option<String>, GatewayError> {
    let rows = messages::repository::list(pool, session_id).await?;
    for row in rows.into_iter().rev() {
        if row.seq <= baseline_seq {
            continue;
        }
        let info: Value = serde_json::from_str(&row.info_json)?;
        if info.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if let Some(text) = text_parts(&row.parts_json)? {
            return Ok(Some(text));
        }
    }
    Ok(None)
}

fn text_parts(parts_json: &str) -> Result<Option<String>, GatewayError> {
    let parts: Value = serde_json::from_str(parts_json)?;
    let text = parts
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    Ok((!text.trim().is_empty()).then_some(text))
}
