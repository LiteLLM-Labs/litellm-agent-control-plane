use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

#[path = "types_error.rs"]
mod errors;
pub use errors::AgentSdkError;

#[path = "types_runtime.rs"]
mod runtime;
pub use runtime::{
    AgentRuntime, AgentRuntimeCatalogEntry, ANTHROPIC_VERSION, CLAUDE_MANAGED_AGENTS, CURSOR,
    DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_CURSOR_BASE_URL, DEFAULT_GEMINI_BASE_URL,
    DEFAULT_OPENCODE_BASE_URL, GEMINI_ANTIGRAVITY, GEMINI_API_REVISION, MANAGED_AGENTS_BETA,
    OPENCODE,
};

#[derive(Debug, Clone)]
pub struct LapConfig {
    pub anthropic_api_key: Option<String>,
    pub anthropic_base_url: String,
    pub cursor_api_key: Option<String>,
    pub cursor_base_url: String,
    pub gemini_api_key: Option<String>,
    pub gemini_base_url: String,
    pub opencode_api_key: Option<String>,
    pub opencode_base_url: Option<String>,
    pub opencode_username: String,
    pub opencode_password: Option<String>,
}

impl LapConfig {
    pub fn anthropic(api_key: impl Into<String>) -> Self {
        Self {
            anthropic_api_key: Some(api_key.into()),
            ..Self::default()
        }
    }

    pub fn cursor(api_key: impl Into<String>) -> Self {
        Self {
            cursor_api_key: Some(api_key.into()),
            ..Self::default()
        }
    }

    pub fn gemini_antigravity(api_key: impl Into<String>) -> Self {
        Self {
            gemini_api_key: Some(api_key.into()),
            ..Self::default()
        }
    }

    pub fn opencode(base_url: impl Into<String>) -> Self {
        Self {
            opencode_base_url: Some(base_url.into()),
            ..Self::default()
        }
    }
}

impl Default for LapConfig {
    fn default() -> Self {
        Self {
            anthropic_api_key: None,
            anthropic_base_url: DEFAULT_ANTHROPIC_BASE_URL.to_owned(),
            cursor_api_key: None,
            cursor_base_url: DEFAULT_CURSOR_BASE_URL.to_owned(),
            gemini_api_key: None,
            gemini_base_url: DEFAULT_GEMINI_BASE_URL.to_owned(),
            opencode_api_key: None,
            opencode_base_url: None,
            opencode_username: "opencode".to_owned(),
            opencode_password: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AgentWorkspace {
    pub repository: String,
    pub ref_name: Option<String>,
    pub auto_create_pr: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateAgentParams {
    #[serde(skip)]
    pub lap_agent_runtime: AgentRuntime,
    #[serde(skip)]
    pub lap_provider_options: Option<Value>,
    pub name: String,
    pub model: AgentModel,
    pub system: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<Value>,
    #[serde(skip)]
    pub env_vars: Option<HashMap<String, String>>,
    #[serde(skip)]
    pub workspace: Option<AgentWorkspace>,
    #[serde(skip)]
    pub metadata: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListAgentsParams {
    #[serde(skip)]
    pub lap_agent_runtime: AgentRuntime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_token: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetAgentParams {
    #[serde(skip)]
    pub lap_agent_runtime: AgentRuntime,
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeleteAgentParams {
    #[serde(skip)]
    pub lap_agent_runtime: AgentRuntime,
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListModelsParams {
    #[serde(skip)]
    pub lap_agent_runtime: AgentRuntime,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub object: String,
    pub created: i64,
    pub owned_by: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelList {
    pub object: String,
    pub data: Vec<ModelInfo>,
}

impl ModelList {
    pub fn from_ids<I, S>(ids: I, owned_by: impl Into<String>) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let owned_by = owned_by.into();
        Self {
            object: "list".to_owned(),
            data: ids
                .into_iter()
                .map(|id| ModelInfo {
                    id: id.into(),
                    object: "model".to_owned(),
                    created: 0,
                    owned_by: owned_by.clone(),
                })
                .collect(),
        }
    }

    pub fn from_provider_value(raw: Value, owned_by: impl Into<String>) -> Option<Self> {
        let owned_by = owned_by.into();
        let items = raw
            .get("data")
            .and_then(Value::as_array)
            .or_else(|| raw.get("models").and_then(Value::as_array))?;
        let data = items
            .iter()
            .filter_map(|item| model_info(item, &owned_by))
            .collect::<Vec<_>>();
        (!data.is_empty()).then(|| Self {
            object: "list".to_owned(),
            data,
        })
    }
}

fn model_info(item: &Value, default_owner: &str) -> Option<ModelInfo> {
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| item.get("name").and_then(Value::as_str))
        .map(|id| id.strip_prefix("models/").unwrap_or(id).to_owned())?;
    Some(ModelInfo {
        id,
        object: "model".to_owned(),
        created: item.get("created").and_then(Value::as_i64).unwrap_or(0),
        owned_by: item
            .get("owned_by")
            .and_then(Value::as_str)
            .unwrap_or(default_owner)
            .to_owned(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum AgentModel {
    Id(String),
    Config(AgentModelConfig),
}

impl From<&str> for AgentModel {
    fn from(value: &str) -> Self {
        Self::Id(value.to_owned())
    }
}

impl From<String> for AgentModel {
    fn from(value: String) -> Self {
        Self::Id(value)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentModelConfig {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateEnvironmentParams {
    #[serde(skip)]
    pub lap_agent_runtime: AgentRuntime,
    pub name: String,
    pub config: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateSessionParams {
    pub agent: String,
    pub environment_id: String,
    pub title: String,
    #[serde(skip)]
    pub lap_agent_runtime: Option<AgentRuntime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resources: Option<Value>,
}

impl CreateSessionParams {
    pub fn opencode(title: impl Into<String>) -> Self {
        Self {
            agent: String::new(),
            environment_id: String::new(),
            title: title.into(),
            lap_agent_runtime: Some(AgentRuntime::OpenCode),
            metadata: None,
            vault_ids: None,
            resources: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SendEventsParams {
    pub events: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SendEventsRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    pub(crate) events: Vec<Value>,
}

impl From<SendEventsParams> for SendEventsRequest {
    fn from(params: SendEventsParams) -> Self {
        Self {
            model: None,
            events: params.events,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ManagedSessionRef {
    pub session_id: String,
    pub lap_agent_runtime: AgentRuntime,
    pub provider_session_id: Option<String>,
    pub provider_agent_id: Option<String>,
    pub provider_run_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ManagedAgent {
    pub id: String,
    pub version: Option<u64>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub model: Option<String>,
    pub system: Option<String>,
    pub tools: Vec<Value>,
    pub mcp_servers: Vec<Value>,
    pub metadata: Option<Value>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ManagedAgentList {
    pub agents: Vec<ManagedAgent>,
    pub next_page_token: Option<String>,
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeleteAgentResponse {
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Environment {
    pub id: String,
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Session {
    pub id: String,
    pub agent: Option<String>,
    pub environment_id: Option<String>,
    pub status: Option<String>,
    pub metadata: Option<Value>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub raw: Value,
}

#[rustfmt::skip]
#[derive(Debug, Clone, PartialEq)] pub struct SendEventsResponse { pub raw: Value }
