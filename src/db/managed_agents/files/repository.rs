use base64::{engine::general_purpose::STANDARD, Engine as _};
use sqlx::PgPool;

use crate::{db::managed_agents::now_ms, errors::GatewayError};

use super::schema::{AgentFileMetadataRow, AgentFileRow};

const MAX_FILE_SIZE_BYTES: usize = 2_000_000;
const MAX_FILES_PER_AGENT: i64 = 100;

pub fn encoding_for_path(path: &str) -> &'static str {
    if path.to_ascii_lowercase().ends_with(".xlsx") {
        "base64"
    } else {
        "utf8"
    }
}

pub async fn upsert(
    pool: &PgPool,
    agent_id: &str,
    path: &str,
    content: String,
    encoding: Option<&str>,
) -> Result<AgentFileRow, GatewayError> {
    validate_path(path)?;
    let encoding = encoding.unwrap_or_else(|| encoding_for_path(path));
    validate_content(&content, encoding)?;
    enforce_count_cap(pool, agent_id, path).await?;

    let now = now_ms();
    let size_bytes = content_size(&content, encoding) as i32;
    sqlx::query_as::<_, AgentFileRow>(
        r#"
        INSERT INTO "LiteLLM_ManagedAgentFilesTable"
          (agent_id, path, content, encoding, size_bytes, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $6)
        ON CONFLICT (agent_id, path) DO UPDATE SET
          content = EXCLUDED.content,
          encoding = EXCLUDED.encoding,
          size_bytes = EXCLUDED.size_bytes,
          updated_at = EXCLUDED.updated_at
        RETURNING *
        "#,
    )
    .bind(agent_id)
    .bind(path)
    .bind(content)
    .bind(encoding)
    .bind(size_bytes)
    .bind(now)
    .fetch_one(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn list(
    pool: &PgPool,
    agent_id: &str,
) -> Result<Vec<AgentFileMetadataRow>, GatewayError> {
    sqlx::query_as::<_, AgentFileMetadataRow>(
        r#"
        SELECT agent_id, path, encoding, size_bytes, created_at, updated_at
        FROM "LiteLLM_ManagedAgentFilesTable"
        WHERE agent_id = $1
        ORDER BY path ASC
        "#,
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn get(
    pool: &PgPool,
    agent_id: &str,
    path: &str,
) -> Result<Option<AgentFileRow>, GatewayError> {
    sqlx::query_as::<_, AgentFileRow>(
        r#"
        SELECT *
        FROM "LiteLLM_ManagedAgentFilesTable"
        WHERE agent_id = $1 AND path = $2
        "#,
    )
    .bind(agent_id)
    .bind(path)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn delete(pool: &PgPool, agent_id: &str, path: &str) -> Result<bool, GatewayError> {
    let result = sqlx::query(
        r#"
        DELETE FROM "LiteLLM_ManagedAgentFilesTable"
        WHERE agent_id = $1 AND path = $2
        "#,
    )
    .bind(agent_id)
    .bind(path)
    .execute(pool)
    .await
    .map_err(GatewayError::Database)?;

    Ok(result.rows_affected() > 0)
}

pub async fn delete_all(pool: &PgPool, agent_id: &str) -> Result<u64, GatewayError> {
    let result = sqlx::query(r#"DELETE FROM "LiteLLM_ManagedAgentFilesTable" WHERE agent_id = $1"#)
        .bind(agent_id)
        .execute(pool)
        .await
        .map_err(GatewayError::Database)?;

    Ok(result.rows_affected())
}

fn validate_path(path: &str) -> Result<(), GatewayError> {
    let basename = path.rsplit('/').next().unwrap_or_default();
    let ext = basename
        .rsplit_once('.')
        .map(|(_, ext)| format!(".{}", ext.to_ascii_lowercase()))
        .unwrap_or_default();
    let allowed = matches!(
        ext.as_str(),
        ".py" | ".md" | ".txt" | ".json" | ".yaml" | ".yml" | ".csv" | ".xlsx" | ".sh" | ".example"
    ) || basename == ".gitignore";
    let valid = !path.is_empty()
        && path.len() <= 240
        && !path.starts_with('/')
        && !path.contains('\\')
        && path
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '/' | ' ' | '-'))
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && allowed;

    if valid {
        Ok(())
    } else {
        Err(GatewayError::InvalidJsonMessage(format!(
            "invalid path: \"{path}\""
        )))
    }
}

fn validate_content(content: &str, encoding: &str) -> Result<(), GatewayError> {
    if !matches!(encoding, "utf8" | "base64") {
        return Err(GatewayError::InvalidJsonMessage(format!(
            "invalid encoding: \"{encoding}\""
        )));
    }
    if encoding == "base64" && STANDARD.decode(content).is_err() {
        return Err(GatewayError::InvalidJsonMessage(
            "invalid base64 content".to_owned(),
        ));
    }
    let size = content_size(content, encoding);
    if size > MAX_FILE_SIZE_BYTES {
        return Err(GatewayError::InvalidJsonMessage(format!(
            "file too large: {size} bytes"
        )));
    }
    Ok(())
}

fn content_size(content: &str, encoding: &str) -> usize {
    if encoding == "base64" {
        STANDARD
            .decode(content)
            .map(|bytes| bytes.len())
            .unwrap_or(0)
    } else {
        content.len()
    }
}

async fn enforce_count_cap(pool: &PgPool, agent_id: &str, path: &str) -> Result<(), GatewayError> {
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM "LiteLLM_ManagedAgentFilesTable"
        WHERE agent_id = $1 AND path != $2
        "#,
    )
    .bind(agent_id)
    .bind(path)
    .fetch_one(pool)
    .await
    .map_err(GatewayError::Database)?;

    if count >= MAX_FILES_PER_AGENT {
        Err(GatewayError::InvalidJsonMessage(format!(
            "agent already has {MAX_FILES_PER_AGENT} files"
        )))
    } else {
        Ok(())
    }
}
