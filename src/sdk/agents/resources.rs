use super::{
    client::Lap,
    events::AgentEventStream,
    types::{
        AgentSdkError, CreateAgentParams, CreateEnvironmentParams, CreateSessionParams,
        DeleteAgentParams, DeleteAgentResponse, Environment, GetAgentParams, ListAgentsParams,
        ManagedAgent, ManagedAgentList, SendEventsParams, SendEventsResponse, Session,
    },
};

// Re-export SessionEvents so it can be referenced as resources::SessionEvents.
pub use super::session_events::SessionEvents;

pub struct Beta<'a> {
    pub(super) client: &'a Lap,
}

impl<'a> Beta<'a> {
    pub fn agents(&self) -> Agents<'a> {
        Agents {
            client: self.client,
        }
    }

    pub fn environments(&self) -> Environments<'a> {
        Environments {
            client: self.client,
        }
    }

    pub fn sessions(&self) -> Sessions<'a> {
        Sessions {
            client: self.client,
        }
    }
}

pub struct Agents<'a> {
    client: &'a Lap,
}

impl Agents<'_> {
    pub async fn create(&self, params: CreateAgentParams) -> Result<ManagedAgent, AgentSdkError> {
        let runtime = params.lap_agent_runtime;
        self.client
            .adapter(runtime)?
            .create_agent(self.client, params)
            .await
    }

    pub async fn list(&self, params: ListAgentsParams) -> Result<ManagedAgentList, AgentSdkError> {
        let runtime = params.lap_agent_runtime;
        self.client
            .adapter(runtime)?
            .list_agents(self.client, params)
            .await
    }

    pub async fn get(&self, params: GetAgentParams) -> Result<ManagedAgent, AgentSdkError> {
        let runtime = params.lap_agent_runtime;
        self.client
            .adapter(runtime)?
            .get_agent(self.client, params)
            .await
    }

    pub async fn delete(
        &self,
        params: DeleteAgentParams,
    ) -> Result<DeleteAgentResponse, AgentSdkError> {
        let runtime = params.lap_agent_runtime;
        self.client
            .adapter(runtime)?
            .delete_agent(self.client, params)
            .await
    }
}

pub struct Environments<'a> {
    client: &'a Lap,
}

impl Environments<'_> {
    pub async fn create(
        &self,
        params: CreateEnvironmentParams,
    ) -> Result<Environment, AgentSdkError> {
        let runtime = params.lap_agent_runtime;
        self.client
            .adapter(runtime)?
            .create_environment(self.client, params)
            .await
    }
}

pub struct Sessions<'a> {
    client: &'a Lap,
}

impl<'a> Sessions<'a> {
    pub async fn create(&self, params: CreateSessionParams) -> Result<Session, AgentSdkError> {
        let runtime = params
            .lap_agent_runtime
            .map(Ok)
            .unwrap_or_else(|| self.client.default_runtime())?;
        self.client
            .adapter(runtime)?
            .create_session(self.client, params)
            .await
    }

    pub fn events(&self) -> SessionEvents<'a> {
        SessionEvents {
            client: self.client,
        }
    }
}

impl Sessions<'_> {
    pub async fn send_events(
        &self,
        session_id: &str,
        params: SendEventsParams,
    ) -> Result<SendEventsResponse, AgentSdkError> {
        self.events().send(session_id, params).await
    }

    pub async fn stream(&self, session_id: &str) -> Result<AgentEventStream, AgentSdkError> {
        self.events().stream(session_id).await
    }
}
