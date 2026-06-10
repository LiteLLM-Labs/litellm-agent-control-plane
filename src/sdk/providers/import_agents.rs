use std::{future::Future, pin::Pin};

use serde_json::Value;

pub type ImportAgentsFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ImportAgentsError>> + Send + 'a>>;

#[derive(Debug)]
pub enum ImportAgentsError {
    Request(reqwest::Error),
    Upstream { status: u16, body: String },
    Decode(serde_json::Error),
}

impl From<reqwest::Error> for ImportAgentsError {
    fn from(error: reqwest::Error) -> Self {
        Self::Request(error)
    }
}

impl From<serde_json::Error> for ImportAgentsError {
    fn from(error: serde_json::Error) -> Self {
        Self::Decode(error)
    }
}

#[derive(Debug, Clone)]
pub struct ImportedAgent {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub model: Option<String>,
    pub provider: String,
    pub raw: Value,
}

pub trait ImportAgentsProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn api_spec(&self) -> &'static str;

    fn discover<'a>(
        &'a self,
        http: &'a reqwest::Client,
        endpoint: &'a str,
        api_key: &'a str,
    ) -> ImportAgentsFuture<'a, Vec<ImportedAgent>>;

    fn default_model(&self, model: Option<&str>) -> String;
    fn system_prompt(&self, external_agent_id: &str) -> String;
}
