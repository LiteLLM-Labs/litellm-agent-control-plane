use serde::{Deserialize, Serialize};

use crate::db::managed_agents::memory::schema::MemoryRow;

#[derive(Debug, Deserialize)]
pub struct StoreMemoryRequest {
    pub key: String,
    pub value: String,
    pub always_on: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct MemoriesResponse {
    pub memories: Vec<MemoryRow>,
}

#[derive(Debug, Serialize)]
pub struct DeleteResponse {
    pub ok: bool,
    pub deleted: bool,
}
