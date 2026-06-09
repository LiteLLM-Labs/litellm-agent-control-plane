use serde::{Deserialize, Serialize};

use crate::db::managed_agents::skills::schema::SkillRow;

#[derive(Debug, Deserialize)]
pub struct ListSkillsQuery {
    pub owner_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SkillsResponse {
    pub skills: Vec<SkillRow>,
}

#[derive(Debug, Serialize)]
pub struct DeleteResponse {
    pub ok: bool,
}
