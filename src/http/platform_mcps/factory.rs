use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db::managed_agents::registry::{
        self,
        schema::{CreateManagedAgent, UpdateManagedAgent},
    },
    errors::GatewayError,
    proxy::state::AppState,
};

use super::{
    public_base_url, required_str, CONNECT_AGENT_TO_SLACK_MCP_ID, CREATE_MANAGED_AGENT_MCP_ID,
    LIST_SLACK_AGENT_BINDINGS_MCP_ID,
};

pub(super) const FACTORY_RUNTIME: &str = "claude_managed_agents";

pub fn tool_defs() -> Vec<Value> {
    vec![
        json!({
            "name": CREATE_MANAGED_AGENT_MCP_ID,
            "description": "Create a DB-backed Claude managed agent. If the user asked to add/install/connect it to Slack, call connect_agent_to_slack immediately after this tool returns.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "instructions": { "type": "string" },
                    "owner_id": { "type": "string" },
                    "description": { "type": "string" },
                    "model": { "type": "string" }
                },
                "required": ["name", "instructions"]
            }
        }),
        json!({
            "name": CONNECT_AGENT_TO_SLACK_MCP_ID,
            "description": "Install or bind a managed agent to the current Slack thread. Use the Slack context values provided in the prompt for team_id, channel_id, thread_ts, dm_user_id, and requested_by instead of asking the user.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agent_id": { "type": "string" },
                    "channel_id": { "type": "string" },
                    "thread_ts": { "type": "string" },
                    "team_id": { "type": "string" },
                    "dm_user_id": { "type": "string" },
                    "requested_by": { "type": "string" }
                },
                "required": ["agent_id", "channel_id", "thread_ts"]
            }
        }),
        json!({
            "name": LIST_SLACK_AGENT_BINDINGS_MCP_ID,
            "description": "List Slack channel bindings for this factory agent.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
    ]
}

pub async fn create_managed_agent(
    state: &AppState,
    pool: &PgPool,
    arguments: Value,
) -> Result<Value, GatewayError> {
    let input = create_agent_input(&arguments)?;
    let row = registry::repository::create(pool, input).await?;
    let row = activate_factory_agent(pool, row).await?;
    Ok(json!({
        "agent_url": agent_url(state, &row.id)?,
        "agent": row,
        "status": "created"
    }))
}

fn create_agent_input(arguments: &Value) -> Result<CreateManagedAgent, GatewayError> {
    let instructions = required_str(arguments, "instructions")?.to_owned();
    Ok(CreateManagedAgent {
        name: required_str(arguments, "name")?.to_owned(),
        owner_id: optional_string(arguments, "owner_id")
            .unwrap_or_else(|| "slack-agent-factory".to_owned()),
        description: optional_string(arguments, "description"),
        runtime: Some(FACTORY_RUNTIME.to_owned()),
        harness: None,
        prompt: Some(instructions.clone()),
        tools: None,
        schedule: None,
        vault_keys: None,
        setup_commands: None,
        max_runtime_minutes: Some(30),
        on_failure: None,
        config: Some(json!({ "runtime": FACTORY_RUNTIME })),
        model: optional_string(arguments, "model"),
        system: Some(instructions),
        skill_ids: None,
        rule_ids: None,
    })
}

async fn activate_factory_agent(
    pool: &PgPool,
    row: registry::schema::ManagedAgentRow,
) -> Result<registry::schema::ManagedAgentRow, GatewayError> {
    registry::repository::update(
        pool,
        &row.id,
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
            config: Some(patch_runtime(row.config)),
            owner_id: None,
            status: Some("active".to_owned()),
            description: None,
            harness: Some(FACTORY_RUNTIME.to_owned()),
            skill_ids: None,
            rule_ids: None,
        },
    )
    .await?
    .ok_or_else(|| GatewayError::NotFound("agent not found after create".to_owned()))
}

fn patch_runtime(config: Value) -> Value {
    let mut root = config.as_object().cloned().unwrap_or_default();
    root.insert("runtime".to_owned(), FACTORY_RUNTIME.into());
    Value::Object(root)
}

fn optional_string(arguments: &Value, field: &str) -> Option<String> {
    arguments
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub(super) fn agent_url(state: &AppState, agent_id: &str) -> Result<String, GatewayError> {
    Ok(format!(
        "{}/agents/detail/?id={}",
        public_base_url(state)?.trim_end_matches('/'),
        agent_id
    ))
}
