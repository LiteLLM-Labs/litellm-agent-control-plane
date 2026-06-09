use serde_json::json;
use sqlx::PgPool;

use crate::errors::GatewayError;

use super::schema::{CreateMcpServer, McpServerRow, UpdateMcpServer};
use super::SELECT_COLS;

pub async fn create(
    pool: &PgPool,
    input: CreateMcpServer,
    actor: &str,
) -> Result<McpServerRow, GatewayError> {
    let server_id = format!("mcp_{}", uuid::Uuid::new_v4().simple());

    let query = format!(
        r#"
        INSERT INTO "LiteLLM_MCPServerTable" (
            server_id,
            server_name,
            alias,
            description,
            instructions,
            url,
            spec_path,
            transport,
            auth_type,
            credentials,
            created_by,
            updated_by,
            mcp_info,
            mcp_access_groups,
            allowed_tools,
            tool_name_to_display_name,
            tool_name_to_description,
            extra_headers,
            static_headers,
            env_vars,
            status,
            command,
            args,
            env,
            authorization_url,
            token_url,
            registration_url,
            oauth2_flow,
            allow_all_keys,
            available_on_public_internet,
            delegate_auth_to_upstream,
            oauth_passthrough,
            is_byok,
            byok_description,
            byok_api_key_help_url,
            source_url,
            timeout,
            approval_status,
            submitted_by,
            review_notes
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
            $31, $32, $33, $34, $35, $36, $37, $38, $39, $40
        )
        RETURNING {SELECT_COLS}
        "#
    );

    sqlx::query_as::<_, McpServerRow>(&query)
        .bind(&server_id)
        .bind(input.server_name)
        .bind(input.alias)
        .bind(input.description)
        .bind(input.instructions)
        .bind(input.url)
        .bind(input.spec_path)
        .bind(input.transport.unwrap_or_else(|| "sse".to_owned()))
        .bind(input.auth_type)
        .bind(input.credentials.unwrap_or_else(|| json!({})))
        .bind(actor)
        .bind(actor)
        .bind(input.mcp_info.unwrap_or_else(|| json!({})))
        .bind(input.mcp_access_groups.unwrap_or_else(|| json!([])))
        .bind(input.allowed_tools.unwrap_or_else(|| json!([])))
        .bind(input.tool_name_to_display_name.unwrap_or_else(|| json!({})))
        .bind(input.tool_name_to_description.unwrap_or_else(|| json!({})))
        .bind(input.extra_headers.unwrap_or_else(|| json!([])))
        .bind(input.static_headers.unwrap_or_else(|| json!({})))
        .bind(input.env_vars.unwrap_or_else(|| json!([])))
        .bind(input.status)
        .bind(input.command)
        .bind(input.args.unwrap_or_else(|| json!([])))
        .bind(input.env.unwrap_or_else(|| json!({})))
        .bind(input.authorization_url)
        .bind(input.token_url)
        .bind(input.registration_url)
        .bind(input.oauth2_flow)
        .bind(input.allow_all_keys.unwrap_or(false))
        .bind(input.available_on_public_internet.unwrap_or(true))
        .bind(input.delegate_auth_to_upstream.unwrap_or(false))
        .bind(input.oauth_passthrough.unwrap_or(false))
        .bind(input.is_byok.unwrap_or(false))
        .bind(input.byok_description.unwrap_or_else(|| json!([])))
        .bind(input.byok_api_key_help_url)
        .bind(input.source_url)
        .bind(input.timeout)
        .bind(input.approval_status.unwrap_or_else(|| "active".to_owned()))
        .bind(input.submitted_by)
        .bind(input.review_notes)
        .fetch_one(pool)
        .await
        .map_err(GatewayError::Database)
}

pub async fn update(
    pool: &PgPool,
    server_id: &str,
    input: UpdateMcpServer,
    actor: &str,
) -> Result<Option<McpServerRow>, GatewayError> {
    let query = format!(
        r#"
        UPDATE "LiteLLM_MCPServerTable"
        SET
            server_name               = COALESCE($2,  server_name),
            alias                     = COALESCE($3,  alias),
            description               = COALESCE($4,  description),
            instructions              = COALESCE($5,  instructions),
            url                       = COALESCE($6,  url),
            spec_path                 = COALESCE($7,  spec_path),
            transport                 = COALESCE($8,  transport),
            auth_type                 = COALESCE($9,  auth_type),
            credentials               = COALESCE($10, credentials),
            updated_by                = $11,
            updated_at                = NOW(),
            mcp_info                  = COALESCE($12, mcp_info),
            mcp_access_groups         = COALESCE($13, mcp_access_groups),
            allowed_tools             = COALESCE($14, allowed_tools),
            tool_name_to_display_name = COALESCE($15, tool_name_to_display_name),
            tool_name_to_description  = COALESCE($16, tool_name_to_description),
            extra_headers             = COALESCE($17, extra_headers),
            static_headers            = COALESCE($18, static_headers),
            env_vars                  = COALESCE($19, env_vars),
            status                    = COALESCE($20, status),
            command                   = COALESCE($21, command),
            args                      = COALESCE($22, args),
            env                       = COALESCE($23, env),
            authorization_url         = COALESCE($24, authorization_url),
            token_url                 = COALESCE($25, token_url),
            registration_url          = COALESCE($26, registration_url),
            oauth2_flow               = COALESCE($27, oauth2_flow),
            allow_all_keys            = COALESCE($28, allow_all_keys),
            available_on_public_internet = COALESCE($29, available_on_public_internet),
            delegate_auth_to_upstream = COALESCE($30, delegate_auth_to_upstream),
            oauth_passthrough         = COALESCE($31, oauth_passthrough),
            is_byok                   = COALESCE($32, is_byok),
            byok_description          = COALESCE($33, byok_description),
            byok_api_key_help_url     = COALESCE($34, byok_api_key_help_url),
            source_url                = COALESCE($35, source_url),
            timeout                   = COALESCE($36, timeout),
            approval_status           = COALESCE($37, approval_status),
            submitted_by              = COALESCE($38, submitted_by),
            submitted_at              = COALESCE(TO_TIMESTAMP($39::BIGINT / 1000.0), submitted_at),
            reviewed_at               = COALESCE(TO_TIMESTAMP($40::BIGINT / 1000.0), reviewed_at),
            review_notes              = COALESCE($41, review_notes)
        WHERE server_id = $1
        RETURNING {SELECT_COLS}
        "#
    );

    sqlx::query_as::<_, McpServerRow>(&query)
        .bind(server_id)
        .bind(input.server_name)
        .bind(input.alias)
        .bind(input.description)
        .bind(input.instructions)
        .bind(input.url)
        .bind(input.spec_path)
        .bind(input.transport)
        .bind(input.auth_type)
        .bind(input.credentials)
        .bind(actor)
        .bind(input.mcp_info)
        .bind(input.mcp_access_groups)
        .bind(input.allowed_tools)
        .bind(input.tool_name_to_display_name)
        .bind(input.tool_name_to_description)
        .bind(input.extra_headers)
        .bind(input.static_headers)
        .bind(input.env_vars)
        .bind(input.status)
        .bind(input.command)
        .bind(input.args)
        .bind(input.env)
        .bind(input.authorization_url)
        .bind(input.token_url)
        .bind(input.registration_url)
        .bind(input.oauth2_flow)
        .bind(input.allow_all_keys)
        .bind(input.available_on_public_internet)
        .bind(input.delegate_auth_to_upstream)
        .bind(input.oauth_passthrough)
        .bind(input.is_byok)
        .bind(input.byok_description)
        .bind(input.byok_api_key_help_url)
        .bind(input.source_url)
        .bind(input.timeout)
        .bind(input.approval_status)
        .bind(input.submitted_by)
        .bind(input.submitted_at)
        .bind(input.reviewed_at)
        .bind(input.review_notes)
        .fetch_optional(pool)
        .await
        .map_err(GatewayError::Database)
}
