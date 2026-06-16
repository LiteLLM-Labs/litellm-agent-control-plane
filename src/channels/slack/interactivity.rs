use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{db::managed_agents::inbox, errors::GatewayError, proxy::state::AppState};

use super::{
    config::{load_agent, load_secret, signing_secret_key, slack_config},
    form::form_field,
    signature,
};

#[derive(Debug, Deserialize)]
struct SlackInteractionPayload {
    actions: Option<Vec<SlackInteractionAction>>,
}

#[derive(Debug, Deserialize)]
struct SlackInteractionAction {
    action_id: String,
    value: Option<String>,
}

#[derive(Debug, Serialize)]
struct SlackInteractionResponse {
    text: String,
}

pub async fn interactivity(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    body: Bytes,
) -> Result<Response, GatewayError> {
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let agent = load_agent(pool, &agent_id).await?;
    let config = slack_config(&agent)?;
    let secret = load_secret(&state, &signing_secret_key(&agent.id, &config)).await?;
    signature::verify(&headers, &body, &secret)?;
    let payload = interaction_payload(&body)?;
    Ok(Json(SlackInteractionResponse {
        text: handle_actions(pool, payload.actions.unwrap_or_default()).await?,
    })
    .into_response())
}

async fn handle_actions(
    pool: &sqlx::PgPool,
    actions: Vec<SlackInteractionAction>,
) -> Result<String, GatewayError> {
    let mut text = "No action taken.".to_owned();
    for action in actions {
        if let Some((decision, item_id)) = approval_action(&action) {
            text = approval_text(decision, decide(pool, decision, &item_id).await?);
        }
    }
    Ok(text)
}

async fn decide(pool: &sqlx::PgPool, decision: &str, item_id: &str) -> Result<bool, GatewayError> {
    match decision {
        "accept" => inbox::repository::decide_approval(pool, item_id, "accept", None, None).await,
        "reject" => {
            inbox::repository::decide_approval(
                pool,
                item_id,
                "reject",
                Some("Rejected from Slack".to_owned()),
                None,
            )
            .await
        }
        _ => Ok(false),
    }
}

fn interaction_payload(body: &[u8]) -> Result<SlackInteractionPayload, GatewayError> {
    let payload_json = form_field(body, "payload")
        .ok_or_else(|| GatewayError::InvalidJsonMessage("payload is required".to_owned()))?;
    serde_json::from_str(&payload_json).map_err(GatewayError::InvalidJson)
}

fn approval_action(action: &SlackInteractionAction) -> Option<(&'static str, String)> {
    let decision = match action.action_id.as_str() {
        "lap_approval_accept" | "approval_accept" => "accept",
        "lap_approval_reject" | "approval_reject" => "reject",
        _ => return None,
    };
    let value = action.value.as_deref()?;
    Some((decision, approval_item_id(value)))
}

fn approval_item_id(value: &str) -> String {
    serde_json::from_str::<Value>(value)
        .ok()
        .and_then(|value| {
            value
                .get("item_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| value.to_owned())
}

fn approval_text(decision: &str, live: bool) -> String {
    if live {
        format!("Approval {decision}ed.")
    } else {
        "Approval was already handled.".to_owned()
    }
}
