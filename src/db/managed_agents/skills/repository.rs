use sqlx::PgPool;

use crate::{
    db::managed_agents::{id, now_ms},
    errors::GatewayError,
};

use super::schema::{CreateSkill, SkillRow, UpdateSkill};

pub async fn create(pool: &PgPool, input: CreateSkill) -> Result<SkillRow, GatewayError> {
    if input.name.trim().is_empty() || input.content.trim().is_empty() {
        return Err(GatewayError::InvalidJsonMessage(
            "name and content required".to_owned(),
        ));
    }

    sqlx::query_as::<_, SkillRow>(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentSkillsTable"
          (id, name, description, content, owner_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
        "#,
    )
    .bind(id("skill"))
    .bind(input.name)
    .bind(input.description)
    .bind(input.content)
    .bind(input.owner_id)
    .bind(now_ms())
    .fetch_one(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn list(pool: &PgPool, owner_id: Option<&str>) -> Result<Vec<SkillRow>, GatewayError> {
    let rows = if let Some(owner_id) = owner_id {
        sqlx::query_as::<_, SkillRow>(
            r#"
            SELECT *
            FROM "LiteLLM_ManagedAgentSkillsTable"
            WHERE owner_id = $1
            ORDER BY created_at ASC
            "#,
        )
        .bind(owner_id)
        .fetch_all(pool)
        .await
    } else {
        sqlx::query_as::<_, SkillRow>(
            r#"
            SELECT *
            FROM "LiteLLM_ManagedAgentSkillsTable"
            ORDER BY created_at ASC
            "#,
        )
        .fetch_all(pool)
        .await
    }
    .map_err(GatewayError::Database)?;

    Ok(rows)
}

pub async fn get(pool: &PgPool, skill_id: &str) -> Result<Option<SkillRow>, GatewayError> {
    sqlx::query_as::<_, SkillRow>(
        r#"SELECT * FROM "LiteLLM_ManagedAgentSkillsTable" WHERE id = $1"#,
    )
    .bind(skill_id)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn update(
    pool: &PgPool,
    skill_id: &str,
    input: UpdateSkill,
) -> Result<Option<SkillRow>, GatewayError> {
    sqlx::query_as::<_, SkillRow>(
        r#"
        UPDATE "LiteLLM_ManagedAgentSkillsTable"
        SET
          name = COALESCE($2, name),
          content = COALESCE($3, content),
          description = COALESCE($4, description)
        WHERE id = $1
        RETURNING *
        "#,
    )
    .bind(skill_id)
    .bind(input.name)
    .bind(input.content)
    .bind(input.description)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn delete(pool: &PgPool, skill_id: &str) -> Result<bool, GatewayError> {
    let result = sqlx::query(r#"DELETE FROM "LiteLLM_ManagedAgentSkillsTable" WHERE id = $1"#)
        .bind(skill_id)
        .execute(pool)
        .await
        .map_err(GatewayError::Database)?;

    Ok(result.rows_affected() > 0)
}
