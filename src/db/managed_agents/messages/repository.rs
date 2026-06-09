use sqlx::PgPool;

use crate::{
    db::managed_agents::{id, sessions},
    errors::GatewayError,
};

use super::schema::SessionMessageRow;

pub async fn list(pool: &PgPool, session_id: &str) -> Result<Vec<SessionMessageRow>, GatewayError> {
    sqlx::query_as::<_, SessionMessageRow>(
        r#"
        SELECT *
        FROM "LiteLLM_ManagedAgentSessionMessagesTable"
        WHERE session_id = $1
        ORDER BY seq ASC
        "#,
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn append(
    pool: &PgPool,
    session_id: &str,
    info_json: &str,
    parts_json: &str,
) -> Result<SessionMessageRow, GatewayError> {
    let mut tx = pool.begin().await.map_err(GatewayError::Database)?;
    let next_seq: i32 = sqlx::query_scalar(
        r#"
        SELECT COALESCE(MAX(seq), 0) + 1
        FROM "LiteLLM_ManagedAgentSessionMessagesTable"
        WHERE session_id = $1
        "#,
    )
    .bind(session_id)
    .fetch_one(tx.as_mut())
    .await
    .map_err(GatewayError::Database)?;

    let row = sqlx::query_as::<_, SessionMessageRow>(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentSessionMessagesTable"
          (id, session_id, seq, info_json, parts_json)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
        "#,
    )
    .bind(id("msg"))
    .bind(session_id)
    .bind(next_seq)
    .bind(info_json)
    .bind(parts_json)
    .fetch_one(tx.as_mut())
    .await
    .map_err(GatewayError::Database)?;

    tx.commit().await.map_err(GatewayError::Database)?;
    sessions::repository::touch(pool, session_id).await?;
    Ok(row)
}
