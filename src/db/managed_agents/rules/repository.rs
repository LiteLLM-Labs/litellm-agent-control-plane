use sqlx::PgPool;

use crate::{
    db::managed_agents::{id, now_ms},
    errors::GatewayError,
};

use super::schema::{CreateRule, RuleRow, UpdateRule};

pub async fn create(pool: &PgPool, input: CreateRule) -> Result<RuleRow, GatewayError> {
    if input.name.trim().is_empty() || input.content.trim().is_empty() {
        return Err(GatewayError::InvalidJsonMessage(
            "name and content required".to_owned(),
        ));
    }

    let now = now_ms();
    sqlx::query_as::<_, RuleRow>(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentRulesTable"
          (id, name, description, content, owner_id, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $6)
        RETURNING *
        "#,
    )
    .bind(id("rule"))
    .bind(input.name)
    .bind(input.description)
    .bind(input.content)
    .bind(input.owner_id)
    .bind(now)
    .fetch_one(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn list(pool: &PgPool, owner_id: Option<&str>) -> Result<Vec<RuleRow>, GatewayError> {
    let rows = if let Some(owner_id) = owner_id {
        sqlx::query_as::<_, RuleRow>(
            r#"
            SELECT *
            FROM "LiteLLM_ManagedAgentRulesTable"
            WHERE owner_id = $1
            ORDER BY created_at ASC
            "#,
        )
        .bind(owner_id)
        .fetch_all(pool)
        .await
    } else {
        sqlx::query_as::<_, RuleRow>(
            r#"
            SELECT *
            FROM "LiteLLM_ManagedAgentRulesTable"
            ORDER BY created_at ASC
            "#,
        )
        .fetch_all(pool)
        .await
    }
    .map_err(GatewayError::Database)?;

    Ok(rows)
}

pub async fn get(pool: &PgPool, rule_id: &str) -> Result<Option<RuleRow>, GatewayError> {
    sqlx::query_as::<_, RuleRow>(r#"SELECT * FROM "LiteLLM_ManagedAgentRulesTable" WHERE id = $1"#)
        .bind(rule_id)
        .fetch_optional(pool)
        .await
        .map_err(GatewayError::Database)
}

pub async fn update(
    pool: &PgPool,
    rule_id: &str,
    input: UpdateRule,
) -> Result<Option<RuleRow>, GatewayError> {
    sqlx::query_as::<_, RuleRow>(
        r#"
        UPDATE "LiteLLM_ManagedAgentRulesTable"
        SET
          name = COALESCE($2, name),
          content = COALESCE($3, content),
          description = COALESCE($4, description),
          updated_at = $5
        WHERE id = $1
        RETURNING *
        "#,
    )
    .bind(rule_id)
    .bind(input.name)
    .bind(input.content)
    .bind(input.description)
    .bind(now_ms())
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn delete(pool: &PgPool, rule_id: &str) -> Result<bool, GatewayError> {
    let result = sqlx::query(r#"DELETE FROM "LiteLLM_ManagedAgentRulesTable" WHERE id = $1"#)
        .bind(rule_id)
        .execute(pool)
        .await
        .map_err(GatewayError::Database)?;

    Ok(result.rows_affected() > 0)
}
