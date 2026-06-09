use sqlx::PgPool;

use crate::errors::GatewayError;

use super::schema::SpendLogRow;

pub async fn list(
    pool: &PgPool,
    q: Option<&str>,
    status: Option<&str>,
    model: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<SpendLogRow>, GatewayError> {
    let search = q.filter(|value| !value.trim().is_empty());
    let status = status.filter(|value| !value.trim().is_empty() && *value != "all");
    let model = model.filter(|value| !value.trim().is_empty());
    sqlx::query_as::<_, SpendLogRow>(
        r#"
        SELECT
          request_id, call_type, api_key, spend, total_tokens, prompt_tokens,
          completion_tokens, "startTime"::TEXT AS "startTime",
          "endTime"::TEXT AS "endTime", request_duration_ms, model, model_id,
          model_group, custom_llm_provider, api_base, "user", metadata,
          cache_hit, cache_key, request_tags, end_user, requester_ip_address,
          messages, response, session_id, status
        FROM "LiteLLM_SpendLogs"
        WHERE ($1::TEXT IS NULL OR request_id ILIKE '%' || $1 || '%' OR model ILIKE '%' || $1 || '%')
          AND ($2::TEXT IS NULL OR status = $2)
          AND ($3::TEXT IS NULL OR model = $3)
        ORDER BY "startTime" DESC
        LIMIT $4 OFFSET $5
        "#,
    )
    .bind(search)
    .bind(status)
    .bind(model)
    .bind(limit.clamp(1, 250))
    .bind(offset.max(0))
    .fetch_all(pool)
    .await
    .map_err(GatewayError::Database)
}

pub async fn get(pool: &PgPool, request_id: &str) -> Result<Option<SpendLogRow>, GatewayError> {
    sqlx::query_as::<_, SpendLogRow>(
        r#"
        SELECT
          request_id, call_type, api_key, spend, total_tokens, prompt_tokens,
          completion_tokens, "startTime"::TEXT AS "startTime",
          "endTime"::TEXT AS "endTime", request_duration_ms, model, model_id,
          model_group, custom_llm_provider, api_base, "user", metadata,
          cache_hit, cache_key, request_tags, end_user, requester_ip_address,
          messages, response, session_id, status
        FROM "LiteLLM_SpendLogs"
        WHERE request_id = $1
        "#,
    )
    .bind(request_id)
    .fetch_optional(pool)
    .await
    .map_err(GatewayError::Database)
}
