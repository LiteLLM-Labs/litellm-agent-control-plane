use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db::managed_agents::{
        registry::{
            self,
            schema::{ManagedAgentRow, UpdateManagedAgent},
        },
        slack,
    },
    errors::GatewayError,
    http::managed_agents::slack::{
        config::{
            app_config_token_key, client_secret_key, load_secret, provider_id_for,
            signing_secret_key,
        },
        manifest_api,
        types::{SlackAgentConfig, DEFAULT_VAULT_USER},
    },
    proxy::{state::AppState, vault},
};

use super::{
    factory::{agent_url, FACTORY_RUNTIME},
    factory_slack_manifest::{build_child_manifest, install_url},
    required_str,
};

pub(crate) async fn create_child_slack_app(
    state: &AppState,
    pool: &PgPool,
    platform: &ManagedAgentRow,
    child: ManagedAgentRow,
    config: &SlackAgentConfig,
    arguments: &Value,
    source_thread_ts: &str,
) -> Result<Value, GatewayError> {
    let token_key = app_config_token_key(&platform.id, config);
    let app_config_token = load_secret(state, &token_key).await?;
    let provider_id = provider_id_for(&child.id);
    let app_name = slack_app_name(&child);
    let created = create_slack_manifest(
        state,
        &app_config_token,
        &child,
        &provider_id,
        &app_name,
        optional_str(arguments, "team_id"),
    )
    .await?;
    let app = created_child_app(&child, &provider_id, app_name, &created)?;
    save_child_credentials(state, pool, &app).await?;
    let child = save_child_slack_app(pool, &child, app.config).await?;
    let oauth_state = slack::repository::create_oauth_state(pool, &child.id, &provider_id).await?;
    create_pending_install(
        pool,
        platform,
        &child,
        arguments,
        source_thread_ts,
        &oauth_state,
    )
    .await?;
    let install_url = install_url(
        state,
        required_child_client_id(&child)?,
        &provider_id,
        &oauth_state,
    )?;
    Ok(json!({
        "status": "slack_app_created",
        "agent_url": agent_url(state, &child.id)?,
        "install_url": install_url,
        "oauth_authorize_url": created.oauth_authorize_url,
        "slack_display": "A dedicated Slack app was created for this agent. Open install_url to add that new bot to the workspace.",
        "source_thread_ts": source_thread_ts,
        "agent": child
    }))
}

async fn create_pending_install(
    pool: &PgPool,
    platform: &ManagedAgentRow,
    child: &ManagedAgentRow,
    arguments: &Value,
    source_thread_ts: &str,
    oauth_state: &str,
) -> Result<(), GatewayError> {
    let channel_id = required_str(arguments, "channel_id")?;
    slack::bindings::create_pending_install(
        pool,
        slack::bindings::PendingInstallInput {
            state: oauth_state,
            platform_agent_id: &platform.id,
            agent_id: &child.id,
            team_id: optional_str(arguments, "team_id"),
            channel_id,
            thread_ts: source_thread_ts,
            dm_user_id: optional_str(arguments, "dm_user_id"),
            requested_by: optional_str(arguments, "requested_by"),
        },
    )
    .await?;
    Ok(())
}

async fn create_slack_manifest(
    state: &AppState,
    app_config_token: &str,
    child: &ManagedAgentRow,
    provider_id: &str,
    app_name: &str,
    team_id: Option<&str>,
) -> Result<manifest_api::SlackManifestCreateResponse, GatewayError> {
    let manifest = build_child_manifest(state, child, provider_id, app_name)?;
    let created = manifest_api::manifest_create(
        &state.http,
        &state.config.slack.api_base_url,
        app_config_token,
        manifest,
        team_id,
    )
    .await?;
    if created.ok {
        Ok(created)
    } else {
        Err(GatewayError::SandboxError(format!(
            "slack apps.manifest.create failed: {}",
            created.error.unwrap_or_else(|| "unknown_error".to_owned())
        )))
    }
}

struct CreatedChildApp {
    config: ChildSlackApp,
    client_secret: String,
    signing_secret: String,
}

fn created_child_app(
    child: &ManagedAgentRow,
    provider_id: &str,
    app_name: String,
    created: &manifest_api::SlackManifestCreateResponse,
) -> Result<CreatedChildApp, GatewayError> {
    let credentials = created.credentials.as_ref().ok_or_else(|| {
        GatewayError::SandboxError("slack apps.manifest.create omitted credentials".to_owned())
    })?;
    Ok(CreatedChildApp {
        config: ChildSlackApp {
            app_name,
            app_id: required_owned(
                created.app_id.clone(),
                "slack manifest response omitted app_id",
            )?,
            client_id: required_owned(
                credentials.client_id.clone(),
                "slack manifest response omitted client_id",
            )?,
            provider_id: provider_id.to_owned(),
            client_secret_key: client_secret_key(child.id.as_str(), &SlackAgentConfig::default()),
            signing_secret_key: signing_secret_key(child.id.as_str(), &SlackAgentConfig::default()),
        },
        client_secret: required_owned(
            credentials.client_secret.clone(),
            "slack manifest response omitted client_secret",
        )?,
        signing_secret: required_owned(
            credentials.signing_secret.clone(),
            "slack manifest response omitted signing_secret",
        )?,
    })
}

async fn save_child_credentials(
    state: &AppState,
    pool: &PgPool,
    app: &CreatedChildApp,
) -> Result<(), GatewayError> {
    vault::save(
        pool,
        &state.config,
        DEFAULT_VAULT_USER,
        &app.config.client_secret_key,
        &app.client_secret,
    )
    .await?;
    vault::save(
        pool,
        &state.config,
        DEFAULT_VAULT_USER,
        &app.config.signing_secret_key,
        &app.signing_secret,
    )
    .await
}

struct ChildSlackApp {
    app_name: String,
    app_id: String,
    client_id: String,
    provider_id: String,
    client_secret_key: String,
    signing_secret_key: String,
}

async fn save_child_slack_app(
    pool: &PgPool,
    child: &ManagedAgentRow,
    app: ChildSlackApp,
) -> Result<ManagedAgentRow, GatewayError> {
    registry::repository::update(
        pool,
        &child.id,
        UpdateManagedAgent {
            name: None,
            model: None,
            runtime: None,
            system: None,
            prompt: None,
            cron: None,
            timezone: None,
            vault_keys: None,
            setup_commands: None,
            max_runtime_minutes: None,
            on_failure: None,
            config: Some(patch_child_slack(&child.config, app)),
            owner_id: None,
            status: None,
            description: None,
            harness: Some(FACTORY_RUNTIME.to_owned()),
            skill_ids: None,
            rule_ids: None,
        },
    )
    .await?
    .ok_or_else(|| GatewayError::NotFound("agent not found after Slack app create".to_owned()))
}

fn required_child_client_id(child: &ManagedAgentRow) -> Result<&str, GatewayError> {
    child
        .config
        .get("slack")
        .and_then(|slack| slack.get("client_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            GatewayError::InvalidConfig("child Slack app is missing client_id".to_owned())
        })
}

fn slack_app_name(child: &ManagedAgentRow) -> String {
    let name = child.name.trim();
    let name = if name.is_empty() { "Lite Agent" } else { name };
    name.chars().take(80).collect()
}

fn patch_child_slack(config: &Value, app: ChildSlackApp) -> Value {
    let mut root = config.as_object().cloned().unwrap_or_default();
    root.insert("runtime".to_owned(), FACTORY_RUNTIME.into());
    root.insert(
        "slack".to_owned(),
        json!({
            "app_name": app.app_name,
            "app_id": app.app_id,
            "client_id": app.client_id,
            "provider_id": app.provider_id,
            "status": "credentials_saved",
            "client_secret_key": app.client_secret_key,
            "signing_secret_key": app.signing_secret_key
        }),
    );
    Value::Object(root)
}

fn required_owned(value: Option<String>, message: &str) -> Result<String, GatewayError> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| GatewayError::SandboxError(message.to_owned()))
}

fn optional_str<'a>(arguments: &'a Value, field: &str) -> Option<&'a str> {
    arguments
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}
