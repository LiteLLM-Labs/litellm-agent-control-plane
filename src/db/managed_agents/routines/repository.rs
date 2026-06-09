use sqlx::PgPool;

use crate::{
    db::managed_agents::{id, now_ms},
    errors::GatewayError,
};

use super::schema::{CreateRoutine, RoutineRow, UpdateRoutine};

pub async fn list(pool: &PgPool, agent_id: Option<&str>) -> Result<Vec<RoutineRow>, GatewayError> {
    let rows = if let Some(agent_id) = agent_id {
        sqlx::query_as::<_, RoutineRow>(
            r#"
            SELECT * FROM "LiteLLM_ManagedAgentRoutinesTable"
            WHERE agent_id = $1
            ORDER BY created_at ASC
            "#,
        )
        .bind(agent_id)
        .fetch_all(pool)
        .await
    } else {
        sqlx::query_as::<_, RoutineRow>(
            r#"
            SELECT * FROM "LiteLLM_ManagedAgentRoutinesTable"
            ORDER BY created_at ASC
            "#,
        )
        .fetch_all(pool)
        .await
    }
    .map_err(GatewayError::Database)?;
    Ok(rows)
}

pub async fn get(pool: &PgPool, routine_id: &str) -> Result<Option<RoutineRow>, GatewayError> {
    sqlx::query_as::<_, RoutineRow>(
        r#"SELECT * FROM "LiteLLM_ManagedAgentRoutinesTable" WHERE id = $1"#,
    )
    .bind(routine_id)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn create(pool: &PgPool, input: CreateRoutine) -> Result<RoutineRow, GatewayError> {
    validate_create_input(&input)?;
    let now = now_ms();
    sqlx::query_as::<_, RoutineRow>(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentRoutinesTable" (
          id, agent_id, name, prompt, cron, timezone, status, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
        RETURNING *
        "#,
    )
    .bind(id("routine"))
    .bind(input.agent_id)
    .bind(input.name)
    .bind(input.prompt.unwrap_or_default())
    .bind(input.cron)
    .bind(input.timezone.unwrap_or_else(|| "UTC".to_owned()))
    .bind(input.status.unwrap_or_else(|| "active".to_owned()))
    .bind(now)
    .fetch_one(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn update(
    pool: &PgPool,
    routine_id: &str,
    input: UpdateRoutine,
) -> Result<Option<RoutineRow>, GatewayError> {
    validate_update_input(&input)?;
    sqlx::query_as::<_, RoutineRow>(
        r#"
        UPDATE "LiteLLM_ManagedAgentRoutinesTable"
        SET
          agent_id = COALESCE($2, agent_id),
          name = COALESCE($3, name),
          prompt = COALESCE($4, prompt),
          cron = COALESCE($5, cron),
          timezone = COALESCE($6, timezone),
          status = COALESCE($7, status),
          updated_at = $8
        WHERE id = $1
        RETURNING *
        "#,
    )
    .bind(routine_id)
    .bind(input.agent_id)
    .bind(input.name)
    .bind(input.prompt)
    .bind(input.cron)
    .bind(input.timezone)
    .bind(input.status)
    .bind(now_ms())
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn mark_triggered(
    pool: &PgPool,
    routine_id: &str,
    run_id: &str,
) -> Result<Option<RoutineRow>, GatewayError> {
    sqlx::query_as::<_, RoutineRow>(
        r#"
        UPDATE "LiteLLM_ManagedAgentRoutinesTable"
        SET last_run_id = $2, last_run_at = $3, updated_at = $3
        WHERE id = $1
        RETURNING *
        "#,
    )
    .bind(routine_id)
    .bind(run_id)
    .bind(now_ms())
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn delete(pool: &PgPool, routine_id: &str) -> Result<bool, GatewayError> {
    let result = sqlx::query(r#"DELETE FROM "LiteLLM_ManagedAgentRoutinesTable" WHERE id = $1"#)
        .bind(routine_id)
        .execute(pool)
        .await
        .map_err(GatewayError::Database)?;
    Ok(result.rows_affected() > 0)
}

fn validate_create_input(input: &CreateRoutine) -> Result<(), GatewayError> {
    if input.agent_id.trim().is_empty()
        || input.name.trim().is_empty()
        || input.cron.trim().is_empty()
    {
        return Err(GatewayError::InvalidJsonMessage(
            "agent_id, name, and cron are required".to_owned(),
        ));
    }
    Ok(())
}

fn validate_update_input(input: &UpdateRoutine) -> Result<(), GatewayError> {
    if input
        .agent_id
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
        || input
            .name
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        || input
            .cron
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
    {
        return Err(GatewayError::InvalidJsonMessage(
            "agent_id, name, and cron cannot be empty".to_owned(),
        ));
    }
    Ok(())
}
