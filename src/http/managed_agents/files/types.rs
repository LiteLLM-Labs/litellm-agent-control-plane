use serde::{Deserialize, Serialize};

use crate::db::managed_agents::files::schema::AgentFileMetadataRow;

#[derive(Debug, Deserialize)]
pub struct FileJsonBody {
    pub content: Option<String>,
    pub content_base64: Option<String>,
    pub encoding: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FilesResponse {
    pub files: Vec<AgentFileMetadataRow>,
}

#[derive(Debug, Serialize)]
pub struct FileUpsertResponse {
    pub ok: bool,
    pub path: String,
    pub encoding: String,
    pub size_bytes: i32,
}

#[derive(Debug, Serialize)]
pub struct DeleteResponse {
    pub ok: bool,
}
