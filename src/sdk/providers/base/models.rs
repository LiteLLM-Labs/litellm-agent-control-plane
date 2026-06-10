use std::{future::Future, pin::Pin, sync::Arc};

use crate::sdk::agents::{AgentRuntime, AgentSdkError, Lap, ListModelsParams, ModelList};

pub(crate) type ModelListFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ModelList, AgentSdkError>> + Send + 'a>>;

pub(crate) struct ModelEndpointEntry {
    pub(crate) runtime: AgentRuntime,
    pub(crate) id: &'static str,
    pub(crate) endpoint: Arc<dyn ModelEndpoint>,
}

#[derive(Default)]
pub(crate) struct ModelEndpointRegistry {
    entries: Vec<ModelEndpointEntry>,
}

impl ModelEndpointRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn register(
        &mut self,
        runtime: AgentRuntime,
        id: &'static str,
        endpoint: impl ModelEndpoint,
    ) {
        self.entries.push(ModelEndpointEntry {
            runtime,
            id,
            endpoint: Arc::new(endpoint),
        });
    }

    pub(crate) fn get(&self, runtime: AgentRuntime) -> Option<Arc<dyn ModelEndpoint>> {
        self.entries
            .iter()
            .find(|entry| entry.runtime == runtime)
            .map(|entry| entry.endpoint.clone())
    }

    pub(crate) fn entry_for_id(&self, id: &str) -> Option<&ModelEndpointEntry> {
        self.entries.iter().find(|entry| entry.id == id)
    }
}

pub(crate) trait ModelEndpoint: Send + Sync + 'static {
    fn list_models<'a>(&'a self, client: &'a Lap, params: ListModelsParams) -> ModelListFuture<'a>;
}

pub(crate) async fn list_openai_shape_or_defaults(
    client: &Lap,
    runtime: AgentRuntime,
    owned_by: &str,
) -> Result<ModelList, AgentSdkError> {
    if let Ok(raw) = client.get(runtime, "/v1/models").await {
        if let Some(models) = ModelList::from_provider_value(raw, owned_by) {
            return Ok(models);
        }
    }
    Ok(ModelList::from_ids(
        runtime.default_model_ids().iter().copied(),
        owned_by,
    ))
}
