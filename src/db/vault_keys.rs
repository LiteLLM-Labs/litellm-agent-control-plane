use serde_json::Value;
use sqlx::PgPool;

use crate::errors::GatewayError;

use super::credentials::CredentialRow;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct VaultKeyRow {
    pub credential_name: String,
    pub scope: String,
    pub owner_id: Option<String>,
    pub updated_at_ms: Option<i64>,
}

/// Upsert a vault key. For personal keys, owner_id must be Some.
pub async fn upsert_vault_key(
    pool: &PgPool,
    key_name: &str,
    scope: &str,
    owner_id: Option<&str>,
    encrypted_value: &str,
    actor: &str,
) -> Result<(), GatewayError> {
    let values = serde_json::json!({ "value": encrypted_value });
    let info = serde_json::json!({ "source": "vault" });

    if scope == "personal" {
        let owner = owner_id.ok_or_else(|| {
            GatewayError::InvalidJsonMessage("owner_id required for personal keys".to_owned())
        })?;
        sqlx::query(
            r#"
            INSERT INTO "LiteLLM_CredentialsTable" (
                credential_id, credential_name, credential_values, credential_info,
                scope, owner_id, created_by, updated_by
            )
            VALUES ($1, $2, $3, $4, 'personal', $5, $6, $6)
            ON CONFLICT (credential_name, owner_id) WHERE scope = 'personal' DO UPDATE SET
                credential_values = EXCLUDED.credential_values,
                credential_info   = EXCLUDED.credential_info,
                updated_at        = CURRENT_TIMESTAMP,
                updated_by        = EXCLUDED.updated_by
            "#,
        )
        .bind(format!("cred_{}", uuid::Uuid::new_v4().simple()))
        .bind(key_name)
        .bind(values)
        .bind(info)
        .bind(owner)
        .bind(actor)
        .execute(pool)
        .await
        .map_err(GatewayError::Database)?;
    } else {
        sqlx::query(
            r#"
            INSERT INTO "LiteLLM_CredentialsTable" (
                credential_id, credential_name, credential_values, credential_info,
                scope, created_by, updated_by
            )
            VALUES ($1, $2, $3, $4, 'global', $5, $5)
            ON CONFLICT (credential_name) WHERE scope = 'global' DO UPDATE SET
                credential_values = EXCLUDED.credential_values,
                credential_info   = EXCLUDED.credential_info,
                updated_at        = CURRENT_TIMESTAMP,
                updated_by        = EXCLUDED.updated_by
            "#,
        )
        .bind(format!("cred_{}", uuid::Uuid::new_v4().simple()))
        .bind(key_name)
        .bind(values)
        .bind(info)
        .bind(actor)
        .execute(pool)
        .await
        .map_err(GatewayError::Database)?;
    }
    Ok(())
}

/// Delete a vault key. Matches on name + scope + owner_id.
pub async fn delete_vault_key(
    pool: &PgPool,
    key_name: &str,
    scope: &str,
    owner_id: Option<&str>,
) -> Result<bool, GatewayError> {
    let result = if scope == "personal" {
        sqlx::query(
            r#"
            DELETE FROM "LiteLLM_CredentialsTable"
            WHERE credential_name = $1 AND scope = 'personal' AND owner_id = $2
            "#,
        )
        .bind(key_name)
        .bind(owner_id)
        .execute(pool)
        .await
    } else {
        sqlx::query(
            r#"
            DELETE FROM "LiteLLM_CredentialsTable"
            WHERE credential_name = $1 AND scope = 'global'
            "#,
        )
        .bind(key_name)
        .execute(pool)
        .await
    }
    .map_err(GatewayError::Database)?;
    Ok(result.rows_affected() > 0)
}

/// List vault keys for a user: returns their personal keys + all global keys.
/// Does NOT return provider credentials (those have names starting with "provider:").
pub async fn list_vault_keys_for_user(
    pool: &PgPool,
    owner_id: &str,
) -> Result<Vec<VaultKeyRow>, GatewayError> {
    sqlx::query_as::<_, VaultKeyRow>(
        r#"
        SELECT
            credential_name,
            scope,
            owner_id,
            CAST(EXTRACT(EPOCH FROM updated_at) * 1000 AS BIGINT) AS updated_at_ms
        FROM "LiteLLM_CredentialsTable"
        WHERE (scope = 'global' OR (scope = 'personal' AND owner_id = $1))
          AND credential_name NOT LIKE 'provider:%'
        ORDER BY scope ASC, credential_name ASC
        "#,
    )
    .bind(owner_id)
    .fetch_all(pool)
    .await
    .map_err(GatewayError::Database)
}

/// Resolve a vault key for a user: personal key takes priority over global.
/// Returns the encrypted value string, or None if not found.
pub async fn resolve_vault_key(
    pool: &PgPool,
    key_name: &str,
    owner_id: &str,
) -> Result<Option<String>, GatewayError> {
    // Try personal key first, then fall back to global.
    let row = sqlx::query_as::<_, CredentialRow>(
        r#"
        SELECT credential_values
        FROM "LiteLLM_CredentialsTable"
        WHERE credential_name = $1
          AND scope = 'personal'
          AND owner_id = $2
        "#,
    )
    .bind(key_name)
    .bind(owner_id)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)?;

    if let Some(row) = row {
        return Ok(extract_vault_value(&row.credential_values));
    }

    let global = sqlx::query_as::<_, CredentialRow>(
        r#"
        SELECT credential_values
        FROM "LiteLLM_CredentialsTable"
        WHERE credential_name = $1 AND scope = 'global'
        "#,
    )
    .bind(key_name)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)?;

    Ok(global.and_then(|r| extract_vault_value(&r.credential_values)))
}

fn extract_vault_value(values: &Value) -> Option<String> {
    values
        .as_object()?
        .get("value")?
        .as_str()
        .map(str::to_owned)
}
