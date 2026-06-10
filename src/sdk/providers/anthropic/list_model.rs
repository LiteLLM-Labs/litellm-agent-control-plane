use crate::sdk::{
    agents::{AgentRuntime, Lap, ListModelsParams},
    providers::base::models::{
        list_openai_shape_or_defaults, ModelEndpoint, ModelListFuture,
    },
};

pub(crate) struct AnthropicModels;

impl ModelEndpoint for AnthropicModels {
    fn list_models<'a>(
        &'a self,
        client: &'a Lap,
        params: ListModelsParams,
    ) -> ModelListFuture<'a> {
        Box::pin(async move {
            list_openai_shape_or_defaults(
                client,
                AgentRuntime::ClaudeManagedAgents,
                params.lap_agent_runtime.as_str(),
            )
            .await
        })
    }
}
