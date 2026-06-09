use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct ListAgentsQuery {
    pub owner_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AgentsResponse<T> {
    pub agents: T,
}

#[derive(Debug, Serialize)]
pub struct AgentStatusResponse {
    pub id: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct DeleteResponse {
    pub ok: bool,
}
