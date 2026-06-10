use serde_json::Value;

use super::{
    client::Lap,
    events::AgentEventStream,
    types::{AgentSdkError, SendEventsParams, SendEventsRequest, SendEventsResponse},
};

pub struct SessionEvents<'a> {
    pub(super) client: &'a Lap,
}

impl SessionEvents<'_> {
    pub async fn send(
        &self,
        session_id: &str,
        params: SendEventsParams,
    ) -> Result<SendEventsResponse, AgentSdkError> {
        self.send_request(session_id, params.into()).await
    }

    pub(crate) async fn send_with_model(
        &self,
        session_id: &str,
        model: Option<String>,
        params: SendEventsParams,
    ) -> Result<SendEventsResponse, AgentSdkError> {
        self.send_request(
            session_id,
            SendEventsRequest {
                model,
                events: params.events,
            },
        )
        .await
    }

    async fn send_request(
        &self,
        session_id: &str,
        request: SendEventsRequest,
    ) -> Result<SendEventsResponse, AgentSdkError> {
        let runtime = self.client.runtime_for_session(session_id)?;
        self.client
            .adapter(runtime)?
            .send_events(self.client, session_id, request)
            .await
    }

    pub async fn stream(&self, session_id: &str) -> Result<AgentEventStream, AgentSdkError> {
        let runtime = self.client.runtime_for_session(session_id)?;
        self.client
            .adapter(runtime)?
            .stream_events(self.client, session_id)
            .await
    }

    pub async fn interrupt(&self, session_id: &str) -> Result<(), AgentSdkError> {
        let runtime = self.client.runtime_for_session(session_id)?;
        self.client
            .adapter(runtime)?
            .interrupt_session(self.client, session_id)
            .await
    }

    pub async fn list(&self, session_id: &str) -> Result<Value, AgentSdkError> {
        let runtime = self.client.runtime_for_session(session_id)?;
        self.client
            .adapter(runtime)?
            .list_events(self.client, session_id)
            .await
    }
}
