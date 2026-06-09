use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::{
    agents::{harnesses, sandboxes},
    errors::GatewayError,
};

#[derive(Debug, Clone, Deserialize)]
pub struct E2bSandboxParams {
    pub e2b_api_key: Option<String>,
    #[serde(default = "default_e2b_template")]
    pub e2b_template: String,
    #[serde(default = "default_timeout_seconds")]
    pub timeout_seconds: u64,
    #[serde(default = "default_workspace_dir")]
    pub workspace_dir: String,
    #[serde(default = "default_e2b_api_base")]
    pub e2b_api_base: String,
    #[serde(default)]
    pub envs: HashMap<String, String>,
}

impl Default for E2bSandboxParams {
    fn default() -> Self {
        Self {
            e2b_api_key: None,
            e2b_template: default_e2b_template(),
            timeout_seconds: default_timeout_seconds(),
            workspace_dir: default_workspace_dir(),
            e2b_api_base: default_e2b_api_base(),
            envs: HashMap::new(),
        }
    }
}

impl E2bSandboxParams {
    fn validate(&self) -> Result<(), GatewayError> {
        if self.e2b_api_key.as_deref().unwrap_or("").trim().is_empty() {
            return Err(GatewayError::InvalidConfig(
                "general_settings.e2b_sandbox_params.e2b_api_key is required".to_owned(),
            ));
        }
        if self.e2b_template.trim().is_empty() {
            return Err(GatewayError::InvalidConfig(
                "general_settings.e2b_sandbox_params.e2b_template cannot be empty".to_owned(),
            ));
        }
        if self.workspace_dir.trim().is_empty() {
            return Err(GatewayError::InvalidConfig(
                "general_settings.e2b_sandbox_params.workspace_dir cannot be empty".to_owned(),
            ));
        }
        Ok(())
    }
}

pub fn validate_agents(
    agents: &[AgentDefinition],
    sandbox_choice: Option<&str>,
    e2b_params: &E2bSandboxParams,
) -> Result<(), GatewayError> {
    if agents.is_empty() {
        return Ok(());
    }

    let choice = sandbox_choice.unwrap_or(sandboxes::default_provider());
    if !sandboxes::is_supported_provider(choice) {
        return Err(GatewayError::InvalidConfig(format!(
            "unsupported sandbox_choice: {choice}"
        )));
    }
    e2b_params.validate()?;

    let mut ids = HashSet::new();
    for agent in agents {
        if agent.name.trim().is_empty() {
            return Err(GatewayError::InvalidConfig(
                "agent name cannot be empty".to_owned(),
            ));
        }
        if agent.model.trim().is_empty() {
            return Err(GatewayError::InvalidConfig(format!(
                "{} is missing model",
                agent.name
            )));
        }
        if agent.system.trim().is_empty() {
            return Err(GatewayError::InvalidConfig(format!(
                "{} is missing system",
                agent.name
            )));
        }
        if !harnesses::is_supported(agent.resolved_harness()) {
            return Err(GatewayError::InvalidConfig(format!(
                "{} has unsupported harness",
                agent.name
            )));
        }

        let id = agent.id();
        if !ids.insert(id.clone()) {
            return Err(GatewayError::InvalidConfig(format!(
                "duplicate agent id: {id}"
            )));
        }
    }

    Ok(())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AgentDefinition {
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub model: String,
    #[serde(default)]
    pub harness: Option<String>,
    pub system: String,
    #[serde(default)]
    pub mcp_servers: Vec<serde_yaml::Value>,
    #[serde(default)]
    pub tools: Vec<HashMap<String, serde_yaml::Value>>,
    #[serde(default)]
    pub skills: Vec<serde_yaml::Value>,
}

impl AgentDefinition {
    pub fn id(&self) -> String {
        self.id
            .as_ref()
            .map(|id| slugify(id))
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| slugify(&self.name))
    }

    pub fn resolved_harness(&self) -> &str {
        self.harness
            .as_deref()
            .unwrap_or(harnesses::claude_code::ID)
    }
}

fn default_e2b_template() -> String {
    "litellm-4gb".to_owned()
}

fn default_timeout_seconds() -> u64 {
    1800
}

fn default_workspace_dir() -> String {
    "/home/user/workspace".to_owned()
}

fn default_e2b_api_base() -> String {
    "https://api.e2b.app".to_owned()
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;

    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
    }

    if slug.ends_with('-') {
        slug.pop();
    }

    slug
}
