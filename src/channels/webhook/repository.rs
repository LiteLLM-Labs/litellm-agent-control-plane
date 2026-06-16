use sqlx::PgPool;

use crate::{db::managed_agents::now_ms, errors::GatewayError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EventRecord {
    Completed { session_id: String },
    Processing,
}

pub(crate) async fn get_event(
    pool: &PgPool,
    agent_id: &str,
    event_id: &str,
) -> Result<Option<EventRecord>, GatewayError> {
    let Some((session_id, status)) = sqlx::query_as::<_, (String, String)>(
        r#"
        SELECT session_id, status
        FROM "LiteLLM_ManagedAgentWebhookEventsTable"
        WHERE agent_id = $1 AND event_id = $2
        "#,
    )
    .bind(agent_id)
    .bind(event_id)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)?
    else {
        return Ok(None);
    };

    if status == "completed" {
        return Ok(Some(EventRecord::Completed { session_id }));
    }
    Ok(Some(EventRecord::Processing))
}

pub(crate) async fn record_event(
    pool: &PgPool,
    agent_id: &str,
    event_id: &str,
    session_id: &str,
) -> Result<bool, GatewayError> {
    let now = now_ms();
    let result = sqlx::query(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentWebhookEventsTable"
          (agent_id, event_id, session_id, status, created_at, updated_at)
        VALUES ($1, $2, $3, 'processing', $4, $4)
        ON CONFLICT (agent_id, event_id) DO NOTHING
        "#,
    )
    .bind(agent_id)
    .bind(event_id)
    .bind(session_id)
    .bind(now)
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn complete_event(
    pool: &PgPool,
    agent_id: &str,
    event_id: &str,
) -> Result<(), GatewayError> {
    sqlx::query(
        r#"
        UPDATE "LiteLLM_ManagedAgentWebhookEventsTable"
        SET status = 'completed', updated_at = $3
        WHERE agent_id = $1 AND event_id = $2
        "#,
    )
    .bind(agent_id)
    .bind(event_id)
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(())
}

pub(crate) async fn delete_event(
    pool: &PgPool,
    agent_id: &str,
    event_id: &str,
) -> Result<(), GatewayError> {
    sqlx::query(
        r#"
        DELETE FROM "LiteLLM_ManagedAgentWebhookEventsTable"
        WHERE agent_id = $1 AND event_id = $2
        "#,
    )
    .bind(agent_id)
    .bind(event_id)
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(())
}
