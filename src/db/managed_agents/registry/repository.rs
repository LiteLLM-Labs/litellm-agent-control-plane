use serde_json::json;
use sqlx::{PgConnection, PgPool};

use crate::{
    agents::harnesses,
    db::managed_agents::{id, now_ms},
    errors::GatewayError,
};

use super::schema::{CreateManagedAgent, ManagedAgentRow, UpdateManagedAgent};

pub async fn create(
    pool: &PgPool,
    input: CreateManagedAgent,
) -> Result<ManagedAgentRow, GatewayError> {
    super::input::validate_create(&input)?;
    let defaults = CreateDefaults::from_input(&input);

    let mut tx = pool.begin().await.map_err(GatewayError::Database)?;
    insert_session(tx.as_mut(), &defaults).await?;
    let row = insert_agent(tx.as_mut(), input, &defaults).await?;
    tx.commit().await.map_err(GatewayError::Database)?;
    Ok(row)
}

struct CreateDefaults {
    now: i64,
    agent_id: String,
    session_id: String,
    title: String,
    model: String,
    system: String,
    harness: String,
    cron: Option<String>,
    timezone: String,
}

impl CreateDefaults {
    fn from_input(input: &CreateManagedAgent) -> Self {
        Self {
            now: now_ms(),
            agent_id: id("agent"),
            session_id: id("ses"),
            title: format!("agent-builder-{}", input.name),
            model: input
                .model
                .clone()
                .unwrap_or_else(|| "claude-sonnet-4-6".to_owned()),
            system: input
                .system
                .clone()
                .or_else(|| input.prompt.clone())
                .unwrap_or_default(),
            harness: input
                .harness
                .as_deref()
                .filter(|harness| harnesses::is_supported(harness))
                .unwrap_or(harnesses::claude_code::ID)
                .to_owned(),
            cron: input
                .schedule
                .as_ref()
                .map(|schedule| schedule.cron.clone()),
            timezone: input
                .schedule
                .as_ref()
                .and_then(|schedule| schedule.timezone.clone())
                .unwrap_or_else(|| "UTC".to_owned()),
        }
    }
}

async fn insert_session(
    conn: &mut PgConnection,
    defaults: &CreateDefaults,
) -> Result<(), GatewayError> {
    sqlx::query(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentSessionsTable"
          (id, harness, agent_id, title, created_at)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(&defaults.session_id)
    .bind(&defaults.harness)
    .bind(&defaults.agent_id)
    .bind(&defaults.title)
    .bind(defaults.now)
    .execute(conn)
    .await
    .map_err(GatewayError::Database)?;
    Ok(())
}

async fn insert_agent(
    conn: &mut PgConnection,
    input: CreateManagedAgent,
    defaults: &CreateDefaults,
) -> Result<ManagedAgentRow, GatewayError> {
    let tools = input.tools.unwrap_or(serde_json::Value::Null);
    let config = super::input::create_config(input.config, input.runtime.as_deref(), &tools);
    sqlx::query_as::<_, ManagedAgentRow>(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentsTable" (
          id, name, model, system, tools, cadence, interval_seconds, session_id,
          loop_id, created_at, prompt, cron, timezone, vault_keys, setup_commands,
          max_runtime_minutes, on_failure, config, owner_id, status, description,
          harness, skill_ids, rule_ids
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, NULL, $7,
          NULL, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, 'paused', $18,
          $19, $20, $21
        )
        RETURNING *
        "#,
    )
    .bind(&defaults.agent_id)
    .bind(input.name)
    .bind(&defaults.model)
    .bind(&defaults.system)
    .bind(&tools)
    .bind(defaults.cron.clone())
    .bind(&defaults.session_id)
    .bind(defaults.now)
    .bind(input.prompt)
    .bind(defaults.cron.clone())
    .bind(&defaults.timezone)
    .bind(input.vault_keys.unwrap_or_else(|| json!([])))
    .bind(input.setup_commands.unwrap_or_else(|| json!([])))
    .bind(input.max_runtime_minutes.unwrap_or(30))
    .bind(
        input
            .on_failure
            .unwrap_or_else(|| "pause_and_notify".to_owned()),
    )
    .bind(config)
    .bind(input.owner_id)
    .bind(input.description)
    .bind(defaults.harness.clone())
    .bind(input.skill_ids.unwrap_or_else(|| json!([])))
    .bind(input.rule_ids.unwrap_or_else(|| json!([])))
    .fetch_one(conn)
    .await
    .map_err(GatewayError::Database)
}

pub async fn list(
    pool: &PgPool,
    owner_id: Option<&str>,
) -> Result<Vec<ManagedAgentRow>, GatewayError> {
    let rows = if let Some(owner_id) = owner_id {
        sqlx::query_as::<_, ManagedAgentRow>(
            r#"
            SELECT * FROM "LiteLLM_ManagedAgentsTable"
            WHERE owner_id = $1
            ORDER BY created_at ASC
            "#,
        )
        .bind(owner_id)
        .fetch_all(pool)
        .await
    } else {
        sqlx::query_as::<_, ManagedAgentRow>(
            r#"
            SELECT * FROM "LiteLLM_ManagedAgentsTable"
            ORDER BY created_at ASC
            "#,
        )
        .fetch_all(pool)
        .await
    }
    .map_err(GatewayError::Database)?;

    Ok(rows)
}

pub async fn get(pool: &PgPool, agent_id: &str) -> Result<Option<ManagedAgentRow>, GatewayError> {
    sqlx::query_as::<_, ManagedAgentRow>(
        r#"SELECT * FROM "LiteLLM_ManagedAgentsTable" WHERE id = $1"#,
    )
    .bind(agent_id)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn update(
    pool: &PgPool,
    agent_id: &str,
    input: UpdateManagedAgent,
) -> Result<Option<ManagedAgentRow>, GatewayError> {
    super::input::validate_update(&input)?;
    sqlx::query_as::<_, ManagedAgentRow>(
        r#"
        UPDATE "LiteLLM_ManagedAgentsTable"
        SET
          name = COALESCE($2, name),
          model = COALESCE($3, model),
          system = COALESCE($4, system),
          prompt = COALESCE($5, prompt),
          cron = COALESCE($6, cron),
          timezone = COALESCE($7, timezone),
          vault_keys = COALESCE($8, vault_keys),
          setup_commands = COALESCE($9, setup_commands),
          max_runtime_minutes = COALESCE($10, max_runtime_minutes),
          on_failure = COALESCE($11, on_failure),
          config = CASE
            WHEN $19::TEXT IS NULL THEN COALESCE($12, config)
            ELSE jsonb_set(COALESCE($12, config), '{runtime}', to_jsonb($19::TEXT), true)
          END,
          owner_id = COALESCE($13, owner_id),
          status = COALESCE($14, status),
          description = COALESCE($15, description),
          harness = COALESCE($16, harness),
          skill_ids = COALESCE($17, skill_ids),
          rule_ids = COALESCE($18, rule_ids)
        WHERE id = $1
        RETURNING *
        "#,
    )
    .bind(agent_id)
    .bind(input.name)
    .bind(input.model)
    .bind(input.system)
    .bind(input.prompt)
    .bind(input.cron)
    .bind(input.timezone)
    .bind(input.vault_keys)
    .bind(input.setup_commands)
    .bind(input.max_runtime_minutes)
    .bind(input.on_failure)
    .bind(input.config)
    .bind(input.owner_id)
    .bind(input.status)
    .bind(input.description)
    .bind(input.harness)
    .bind(input.skill_ids)
    .bind(input.rule_ids)
    .bind(input.runtime)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn set_status(
    pool: &PgPool,
    agent_id: &str,
    status: &str,
) -> Result<Option<ManagedAgentRow>, GatewayError> {
    sqlx::query_as::<_, ManagedAgentRow>(
        r#"
        UPDATE "LiteLLM_ManagedAgentsTable"
        SET status = $2
        WHERE id = $1
        RETURNING *
        "#,
    )
    .bind(agent_id)
    .bind(status)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn delete(pool: &PgPool, agent_id: &str) -> Result<bool, GatewayError> {
    let result = sqlx::query(r#"DELETE FROM "LiteLLM_ManagedAgentsTable" WHERE id = $1"#)
        .bind(agent_id)
        .execute(pool)
        .await
        .map_err(GatewayError::Database)?;

    Ok(result.rows_affected() > 0)
}
