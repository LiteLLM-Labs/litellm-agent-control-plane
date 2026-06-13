use sqlx::PgPool;

use crate::{db::managed_agents::now_ms, errors::GatewayError};

use super::schema::TeamsConversationSessionRow;

pub async fn get(
    pool: &PgPool,
    agent_id: &str,
    conversation_id: &str,
) -> Result<Option<TeamsConversationSessionRow>, GatewayError> {
    sqlx::query_as::<_, TeamsConversationSessionRow>(
        r#"
        SELECT *
        FROM "LiteLLM_ManagedAgentTeamsConversationSessionsTable"
        WHERE agent_id = $1 AND conversation_id = $2
        "#,
    )
    .bind(agent_id)
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

pub struct UpsertConversationInput<'a> {
    pub agent_id: &'a str,
    pub conversation_id: &'a str,
    pub session_id: &'a str,
    pub service_url: &'a str,
    pub tenant_id: Option<&'a str>,
    pub team_id: Option<&'a str>,
    pub channel_id: Option<&'a str>,
}

pub async fn upsert(
    pool: &PgPool,
    input: UpsertConversationInput<'_>,
) -> Result<TeamsConversationSessionRow, GatewayError> {
    let now = now_ms();
    sqlx::query_as::<_, TeamsConversationSessionRow>(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentTeamsConversationSessionsTable"
          (agent_id, conversation_id, session_id, service_url, tenant_id, team_id, channel_id, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
        ON CONFLICT (agent_id, conversation_id) DO UPDATE SET
          service_url = EXCLUDED.service_url,
          tenant_id = EXCLUDED.tenant_id,
          team_id = EXCLUDED.team_id,
          channel_id = EXCLUDED.channel_id,
          updated_at = EXCLUDED.updated_at
        RETURNING *
        "#,
    )
    .bind(input.agent_id)
    .bind(input.conversation_id)
    .bind(input.session_id)
    .bind(input.service_url)
    .bind(input.tenant_id)
    .bind(input.team_id)
    .bind(input.channel_id)
    .bind(now)
    .fetch_one(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn record_event(
    pool: &PgPool,
    agent_id: &str,
    event_id: &str,
) -> Result<bool, GatewayError> {
    let result = sqlx::query(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentTeamsEventsTable" (agent_id, event_id, created_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (agent_id, event_id) DO NOTHING
        "#,
    )
    .bind(agent_id)
    .bind(event_id)
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(result.rows_affected() == 1)
}
