use std::sync::Arc;

use axum::{
    routing::{delete, get, post, put},
    Router,
};

use crate::proxy::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .merge(agent_routes())
        .merge(rule_routes())
        .merge(routine_routes())
        .merge(skill_routes())
        .merge(inbox_routes())
        .merge(slack_routes())
}

fn agent_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/agents",
            post(super::registry::create::create).get(super::registry::list::list),
        )
        .route(
            "/api/agents/{agent_id}",
            get(super::registry::get::get)
                .patch(super::registry::update::update)
                .delete(super::registry::delete::delete),
        )
        .route(
            "/api/agents/{agent_id}/pause",
            post(super::registry::pause::pause),
        )
        .route(
            "/api/agents/{agent_id}/resume",
            post(super::registry::resume::resume),
        )
        .route(
            "/api/agents/{agent_id}/files",
            get(super::files::list::list).delete(super::files::delete_all::delete_all),
        )
        .route(
            "/api/agents/{agent_id}/files/{*path}",
            put(super::files::upsert::upsert)
                .get(super::files::get::get)
                .delete(super::files::delete::delete),
        )
        .route(
            "/api/agents/{agent_id}/memory",
            get(super::memory::list::list).post(super::memory::store::store),
        )
        .route(
            "/api/agents/{agent_id}/memory/{key}",
            delete(super::memory::delete::delete),
        )
        .route(
            "/api/agents/{agent_id}/run",
            post(super::runs::create::create),
        )
        .route("/api/agents/{agent_id}/runs", get(super::runs::list::list))
        .route(
            "/api/agents/{agent_id}/runs/{run_id}/logs",
            get(super::runs::logs::logs),
        )
}

fn rule_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/rules",
            post(super::rules::create::create).get(super::rules::list::list),
        )
        .route(
            "/api/rules/{rule_id}",
            get(super::rules::get::get)
                .patch(super::rules::update::update)
                .delete(super::rules::delete::delete),
        )
}

fn routine_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/routines",
            post(super::routines::create::create).get(super::routines::list::list),
        )
        .route(
            "/api/routines/{routine_id}",
            axum::routing::patch(super::routines::update::update)
                .delete(super::routines::delete::delete),
        )
        .route(
            "/api/routines/{routine_id}/trigger",
            post(super::routines::trigger::trigger),
        )
}

fn skill_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/skills",
            post(super::skills::create::create).get(super::skills::list::list),
        )
        .route(
            "/api/skills/{skill_id}",
            get(super::skills::get::get)
                .patch(super::skills::update::update)
                .delete(super::skills::delete::delete),
        )
}

fn inbox_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/inbox", get(super::inbox::list::list))
        .route(
            "/api/inbox/{item_id}/resolve",
            post(super::inbox::resolve::resolve),
        )
        .route("/api/approvals", get(super::inbox::approvals::list_pending))
        .route(
            "/api/approvals/{item_id}/accept",
            post(super::inbox::approvals::accept),
        )
        .route(
            "/api/approvals/{item_id}/reject",
            post(super::inbox::approvals::reject),
        )
}

fn slack_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/agents/{agent_id}/slack/events",
            post(super::slack::events),
        )
        .route(
            "/api/agents/{agent_id}/slack/interactivity",
            post(super::slack::interactivity),
        )
        .route(
            "/api/agents/{agent_id}/slack/oauth-state",
            post(super::slack::oauth_state),
        )
        .route(
            "/host-oauth-callback/{provider_id}",
            get(super::slack::oauth_callback),
        )
}
