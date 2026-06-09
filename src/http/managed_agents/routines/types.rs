use serde::{Deserialize, Serialize};

use crate::db::managed_agents::routines::schema::RoutineRow;

#[derive(Debug, Deserialize)]
pub struct ListRoutinesQuery {
    pub agent_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RoutinesResponse {
    pub routines: Vec<RoutineRow>,
}
