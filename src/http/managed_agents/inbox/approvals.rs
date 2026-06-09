use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use sqlx::PgPool;

use crate::{
    db::managed_agents::inbox::{repository, schema::InboxItemRow},
    errors::GatewayError,
    proxy::state::AppState,
};

use super::types::{AcceptRequest, ApprovalsResponse, DecisionResponse, RejectRequest};

pub async fn list_pending(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<ApprovalsResponse>, GatewayError> {
    let pool = super::super::db(&state, &headers)?;
    Ok(Json(ApprovalsResponse {
        approvals: repository::pending_approvals(pool).await?,
    }))
}

pub async fn accept(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    Json(input): Json<AcceptRequest>,
) -> Result<Json<DecisionResponse>, GatewayError> {
    let pool = super::super::db(&state, &headers)?.clone();
    let live =
        repository::decide_approval(&pool, &item_id, "accept", None, input.arguments).await?;
    resume_linked_session(state, pool, &item_id).await;
    Ok(Json(DecisionResponse { ok: true, live }))
}

pub async fn reject(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    Json(input): Json<RejectRequest>,
) -> Result<Json<DecisionResponse>, GatewayError> {
    let pool = super::super::db(&state, &headers)?.clone();
    let live = repository::decide_approval(&pool, &item_id, "reject", input.feedback, None).await?;
    resume_linked_session(state, pool, &item_id).await;
    Ok(Json(DecisionResponse { ok: true, live }))
}

async fn resume_linked_session(state: Arc<AppState>, pool: PgPool, item_id: &str) {
    let Ok(Some(item)) = repository::get(&pool, item_id).await else {
        return;
    };
    let Some(session_id) = item.session_id.as_deref() else {
        return;
    };
    if let Err(error) = crate::http::sessions::enqueue_prompt_text(
        state,
        pool,
        session_id,
        resume_prompt(&item),
        "claude-sonnet-4-6".to_owned(),
    )
    .await
    {
        tracing::warn!(
            approval_id = %item.id,
            session_id,
            error = %error,
            "failed to resume session after approval decision"
        );
    }
}

fn resume_prompt(item: &InboxItemRow) -> String {
    match item.status.as_str() {
        "accepted" => format!(
            "Human approved approval {}.\nTitle: {}\nApproved arguments:\n{}\nContinue the session using this decision.",
            item.id,
            item.title,
            item.args_json.as_deref().unwrap_or("{}")
        ),
        "rejected" => format!(
            "Human rejected approval {}.\nTitle: {}\nFeedback: {}\nDo not proceed with the requested action; adjust based on this feedback.",
            item.id,
            item.title,
            item.feedback.as_deref().unwrap_or("No feedback provided.")
        ),
        _ => format!(
            "Human approval {} is still {}. Do not proceed until it is accepted or rejected.",
            item.id, item.status
        ),
    }
}
