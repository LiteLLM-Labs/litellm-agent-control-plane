use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    db::managed_agents::registry::schema::ManagedAgentRow,
    errors::GatewayError,
    sdk::providers::import_agents::{ImportAgentsError, ImportedAgent},
};

#[derive(Debug, Clone, Serialize)]
pub struct ImportProviderResponse {
    pub id: &'static str,
    pub name: &'static str,
    pub api_spec: &'static str,
}

#[derive(Debug, Deserialize)]
pub struct DiscoverAgentsRequest {
    pub endpoint: String,
    pub api_key: String,
}

#[derive(Debug, Serialize)]
pub struct DiscoverAgentsResponse {
    pub agents: Vec<ExternalAgent>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ExternalAgent {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub model: Option<String>,
    pub provider: String,
    pub raw: Value,
}

#[derive(Debug, Deserialize)]
pub struct ImportAgentsRequest {
    pub endpoint: String,
    pub api_key: Option<String>,
    pub credential_mode: CredentialMode,
    pub owner_id: Option<String>,
    pub agents: Vec<ImportAgent>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialMode {
    Shared,
    Byo,
}

impl CredentialMode {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Shared => "shared",
            Self::Byo => "byo",
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ImportAgent {
    pub external_id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub model: Option<String>,
    pub raw: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct ImportAgentsResponse {
    pub agents: Vec<ManagedAgentRow>,
}

pub(crate) fn provider_error(error: ImportAgentsError) -> GatewayError {
    match error {
        ImportAgentsError::Request(error) => GatewayError::Upstream(error),
        ImportAgentsError::Upstream { status, body } => GatewayError::UpstreamHttp(status, body),
        ImportAgentsError::Decode(error) => {
            GatewayError::InvalidConfig(format!("invalid provider response: {error}"))
        }
    }
}

impl From<ImportedAgent> for ExternalAgent {
    fn from(agent: ImportedAgent) -> Self {
        Self {
            id: agent.id,
            name: agent.name,
            description: agent.description,
            model: agent.model,
            provider: agent.provider,
            raw: agent.raw,
        }
    }
}
