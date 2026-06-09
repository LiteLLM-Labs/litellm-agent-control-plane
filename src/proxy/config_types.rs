use std::{
    collections::HashMap,
    ops::{Deref, DerefMut},
};

use serde::Deserialize;

use crate::{
    agents::config::{AgentDefinition, E2bSandboxParams},
    proxy::mcp_config::McpServerEntry,
};

#[derive(Debug, Clone, Deserialize)]
pub struct GatewayConfig {
    #[serde(default)]
    pub model_list: Vec<ModelEntry>,

    #[serde(default)]
    pub mcp_servers: McpServersConfig,

    #[serde(default)]
    pub general_settings: GeneralSettings,

    #[serde(default)]
    pub slack: SlackSettings,

    #[serde(default)]
    pub agents: Vec<AgentDefinition>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GeneralSettings {
    pub master_key: Option<String>,
    pub database_url: Option<String>,
    pub public_base_url: Option<String>,
    #[serde(default)]
    pub store_prompts_in_spend_logs: bool,
    #[serde(default)]
    pub disable_spend_logs: bool,
    #[serde(default = "default_spend_logs_batch_interval_seconds")]
    pub spend_logs_batch_interval_seconds: u64,
    #[serde(default = "default_spend_logs_batch_size")]
    pub spend_logs_batch_size: usize,
    #[serde(default = "default_spend_logs_queue_capacity")]
    pub spend_logs_queue_capacity: usize,
    pub sandbox_choice: Option<String>,
    #[serde(default)]
    pub e2b_sandbox_params: E2bSandboxParams,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            master_key: None,
            database_url: None,
            public_base_url: None,
            store_prompts_in_spend_logs: false,
            disable_spend_logs: false,
            spend_logs_batch_interval_seconds: default_spend_logs_batch_interval_seconds(),
            spend_logs_batch_size: default_spend_logs_batch_size(),
            spend_logs_queue_capacity: default_spend_logs_queue_capacity(),
            sandbox_choice: None,
            e2b_sandbox_params: E2bSandboxParams::default(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct McpServersConfig {
    #[serde(default)]
    pub proxy_base_url: Option<String>,

    #[serde(flatten)]
    servers: HashMap<String, McpServerEntry>,
}

impl McpServersConfig {
    pub fn proxy_base_url(&self) -> Option<&str> {
        self.proxy_base_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }
}

impl Deref for McpServersConfig {
    type Target = HashMap<String, McpServerEntry>;

    fn deref(&self) -> &Self::Target {
        &self.servers
    }
}

impl DerefMut for McpServersConfig {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.servers
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SlackSettings {
    #[serde(default = "default_slack_api_base_url")]
    pub api_base_url: String,
}

impl Default for SlackSettings {
    fn default() -> Self {
        Self {
            api_base_url: default_slack_api_base_url(),
        }
    }
}

fn default_slack_api_base_url() -> String {
    "https://slack.com/api".to_owned()
}

fn default_spend_logs_batch_interval_seconds() -> u64 {
    10
}

fn default_spend_logs_batch_size() -> usize {
    100
}

fn default_spend_logs_queue_capacity() -> usize {
    10_000
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelEntry {
    pub model_name: String,
    pub litellm_params: LiteLlmParams,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LiteLlmParams {
    pub model: String,
    pub api_key: Option<String>,
    pub api_base: Option<String>,

    #[serde(flatten)]
    pub extra: HashMap<String, serde_yaml::Value>,
}
