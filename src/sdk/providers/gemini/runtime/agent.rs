use serde_json::{json, Map, Value};

use crate::sdk::agents::{
    response_fields::id, AgentModel, AgentSdkError, AgentWorkspace, ListAgentsParams,
    ManagedAgent,
};

use super::DEFAULT_ENVIRONMENT_ID;

const BASE_AGENT_ID: &str = "antigravity-preview-05-2026";
const SUPPORTED_TOOL_TYPES: &[&str] = &["code_execution", "google_search", "url_context"];

pub(super) fn create_agent_body(params: crate::sdk::agents::CreateAgentParams) -> Result<Value, AgentSdkError> {
    let options = params.lap_provider_options.clone();
    let base_agent = model_id(&params.model);
    let mut body = Map::new();
    body.insert("id".to_owned(), Value::String(agent_id(&params.name)));
    body.insert("base_agent".to_owned(), Value::String(base_agent));
    if !params.system.trim().is_empty() {
        body.insert(
            "system_instruction".to_owned(),
            Value::String(params.system),
        );
    }
    if let Some(description) = params.description {
        body.insert("description".to_owned(), Value::String(description));
    }
    let tools = supported_tools(params.tools);
    if !tools.is_empty() {
        body.insert("tools".to_owned(), Value::Array(tools));
    }
    let base_environment = base_environment(params.workspace);
    body.insert("base_environment".to_owned(), base_environment);
    if let Some(Value::Object(options)) = options {
        body.extend(options);
    }
    Ok(Value::Object(body))
}

fn model_id(model: &AgentModel) -> String {
    let id = match model {
        AgentModel::Id(id) => id.trim(),
        AgentModel::Config(config) => config.id.trim(),
    };
    if id.is_empty() {
        BASE_AGENT_ID.to_owned()
    } else {
        id.to_owned()
    }
}

fn agent_id(name: &str) -> String {
    let mut id = String::new();
    let mut last_was_dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            id.push(ch.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash && !id.is_empty() {
            id.push('-');
            last_was_dash = true;
        }
    }
    while id.ends_with('-') {
        id.pop();
    }
    if id.is_empty() {
        "lap-agent".to_owned()
    } else {
        id
    }
}

fn base_environment(workspace: Option<AgentWorkspace>) -> Value {
    let Some(workspace) = workspace else {
        return Value::String(DEFAULT_ENVIRONMENT_ID.to_owned());
    };
    if workspace.repository.trim().is_empty() {
        return Value::String(DEFAULT_ENVIRONMENT_ID.to_owned());
    }
    let repository = workspace.repository;
    let ref_name = workspace.ref_name;
    let mut source = json!({
        "type": "repository",
        "source": repository,
        "target": "/workspace/repo"
    });
    if let Some(ref_name) = ref_name
        .as_deref()
        .map(str::trim)
        .filter(|ref_name| !ref_name.is_empty())
    {
        if let Some(source) = source.as_object_mut() {
            source.insert("ref".to_owned(), Value::String(ref_name.to_owned()));
        }
    }
    json!({
        "type": "remote",
        "sources": [source]
    })
}

fn supported_tools(tools: Vec<Value>) -> Vec<Value> {
    tools
        .into_iter()
        .filter(|tool| {
            tool.get("type")
                .and_then(Value::as_str)
                .is_some_and(|tool_type| SUPPORTED_TOOL_TYPES.contains(&tool_type))
        })
        .collect()
}

pub(super) fn managed_agent(raw: Value) -> Result<ManagedAgent, AgentSdkError> {
    Ok(ManagedAgent {
        id: id(&raw)?,
        version: None,
        name: raw
            .get("display_name")
            .or_else(|| raw.get("name"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        description: raw
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned),
        model: raw
            .get("base_agent")
            .and_then(Value::as_str)
            .map(str::to_owned),
        system: raw
            .get("system_instruction")
            .and_then(Value::as_str)
            .map(str::to_owned),
        tools: raw
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        mcp_servers: Vec::new(),
        metadata: None,
        created_at: None,
        updated_at: None,
        raw,
    })
}

pub(super) fn list_agents_path(params: ListAgentsParams) -> String {
    let mut query = Vec::new();
    if let Some(page_size) = params.page_size {
        query.push(format!("pageSize={page_size}"));
    }
    if let Some(page_token) = params.page_token {
        query.push(format!("pageToken={page_token}"));
    }
    if query.is_empty() {
        "/v1beta/agents".to_owned()
    } else {
        format!("/v1beta/agents?{}", query.join("&"))
    }
}
