use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct RuleRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub content: String,
    pub owner_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct CreateRule {
    pub name: String,
    pub content: String,
    pub description: Option<String>,
    pub owner_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateRule {
    pub name: Option<String>,
    pub content: Option<String>,
    pub description: Option<String>,
}
