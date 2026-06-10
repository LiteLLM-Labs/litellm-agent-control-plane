use serde_json::Value;

use crate::sdk::providers::import_agents::{
    ImportAgentsError, ImportAgentsFuture, ImportAgentsProvider, ImportedAgent,
};

pub static ELASTIC_IMPORT_AGENTS: ElasticImportAgents = ElasticImportAgents;

pub struct ElasticImportAgents;

impl ImportAgentsProvider for ElasticImportAgents {
    fn id(&self) -> &'static str {
        "elastic"
    }

    fn name(&self) -> &'static str {
        "Elastic"
    }

    fn api_spec(&self) -> &'static str {
        "elastic_agent_builder"
    }

    fn discover<'a>(
        &'a self,
        http: &'a reqwest::Client,
        endpoint: &'a str,
        api_key: &'a str,
    ) -> ImportAgentsFuture<'a, Vec<ImportedAgent>> {
        Box::pin(async move {
            let response = http
                .get(format!("{endpoint}/api/agent_builder/agents"))
                .header("authorization", format!("ApiKey {api_key}"))
                .header("accept", "application/json")
                .send()
                .await?;
            let status = response.status();
            let body = response.text().await?;
            if !status.is_success() {
                return Err(ImportAgentsError::Upstream {
                    status: status.as_u16(),
                    body,
                });
            }
            let raw: Value = serde_json::from_str(&body)?;
            let values = raw
                .as_array()
                .cloned()
                .or_else(|| raw.get("agents").and_then(Value::as_array).cloned())
                .or_else(|| raw.get("data").and_then(Value::as_array).cloned())
                .or_else(|| raw.get("results").and_then(Value::as_array).cloned())
                .unwrap_or_default();
            Ok(values
                .into_iter()
                .filter_map(|raw| external_agent(self.id(), raw))
                .collect())
        })
    }

    fn default_model(&self, model: Option<&str>) -> String {
        model
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("elastic-agent-builder")
            .to_owned()
    }

    fn system_prompt(&self, external_agent_id: &str) -> String {
        format!(
            "This LAP agent is an imported Elastic Agent Builder agent. External agent id: {external_agent_id}. Route execution to the external provider with the configured credential policy."
        )
    }
}

fn external_agent(provider: &str, raw: Value) -> Option<ImportedAgent> {
    let id = raw.get("id").and_then(Value::as_str)?.trim().to_owned();
    if id.is_empty() {
        return None;
    }
    let name = raw
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(id.as_str())
        .to_owned();
    let description = raw
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let model = raw
        .get("model")
        .and_then(Value::as_str)
        .or_else(|| {
            raw.get("model_usage")
                .and_then(|usage| usage.get("model"))
                .and_then(Value::as_str)
        })
        .map(str::to_owned);
    Some(ImportedAgent {
        id,
        name,
        description,
        model,
        provider: provider.to_owned(),
        raw,
    })
}
