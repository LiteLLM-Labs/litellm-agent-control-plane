use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::managed_agents::inbox::schema::InboxItemRow;

#[derive(Debug, Deserialize)]
pub struct ListInboxQuery {
    pub filter: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct InboxResponse {
    pub items: Vec<InboxItemRow>,
}

#[derive(Debug, Serialize)]
pub struct ApprovalsResponse {
    pub approvals: Vec<InboxItemRow>,
}

#[derive(Debug, Deserialize)]
pub struct ResolveRequest {
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AcceptRequest {
    pub arguments: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct RejectRequest {
    pub feedback: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DecisionResponse {
    pub ok: bool,
    pub live: bool,
}

#[derive(Debug, Serialize)]
pub struct OkResponse {
    pub ok: bool,
}
