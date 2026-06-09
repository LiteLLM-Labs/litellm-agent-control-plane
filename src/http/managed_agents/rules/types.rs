use serde::{Deserialize, Serialize};

use crate::db::managed_agents::rules::schema::RuleRow;

#[derive(Debug, Deserialize)]
pub struct ListRulesQuery {
    pub owner_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RulesResponse {
    pub rules: Vec<RuleRow>,
}

#[derive(Debug, Serialize)]
pub struct DeleteResponse {
    pub ok: bool,
}
