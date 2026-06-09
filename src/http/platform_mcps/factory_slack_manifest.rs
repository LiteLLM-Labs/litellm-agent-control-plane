use serde_json::{json, Value};

use crate::{
    db::managed_agents::registry::schema::ManagedAgentRow, errors::GatewayError,
    proxy::state::AppState,
};

use super::public_base_url;

const SLACK_SCOPES: &str = "app_mentions:read,channels:history,channels:read,chat:write,chat:write.customize,groups:history,groups:read,im:history,im:read,im:write,mpim:history,mpim:read,reactions:write,team:read,users:read";

pub(super) fn build_child_manifest(
    state: &AppState,
    child: &ManagedAgentRow,
    provider_id: &str,
    app_name: &str,
) -> Result<Value, GatewayError> {
    let base_url = public_base_url(state)?;
    let base_url = base_url.trim_end_matches('/');
    Ok(json!({
        "display_information": display_information(app_name),
        "features": features(app_name),
        "oauth_config": {
            "redirect_urls": [format!("{base_url}/host-oauth-callback/{provider_id}")],
            "scopes": { "bot": slack_scopes() }
        },
        "settings": {
            "event_subscriptions": {
                "request_url": format!("{base_url}/api/agents/{}/slack/events", encode_component(&child.id)),
                "bot_events": ["app_mention", "message.channels", "message.groups", "message.im", "message.mpim"]
            },
            "interactivity": {
                "is_enabled": true,
                "request_url": format!("{base_url}/api/agents/{}/slack/interactivity", encode_component(&child.id))
            },
            "org_deploy_enabled": false,
            "socket_mode_enabled": false,
            "token_rotation_enabled": false
        }
    }))
}

pub(super) fn install_url(
    state: &AppState,
    client_id: &str,
    provider_id: &str,
    oauth_state: &str,
) -> Result<String, GatewayError> {
    let base_url = public_base_url(state)?;
    let redirect_uri = format!(
        "{}/host-oauth-callback/{provider_id}",
        base_url.trim_end_matches('/')
    );
    Ok(format!(
        "https://slack.com/oauth/v2/authorize?client_id={}&scope={}&redirect_uri={}&state={}",
        encode_component(client_id),
        encode_component(SLACK_SCOPES),
        encode_component(&redirect_uri),
        encode_component(oauth_state)
    ))
}

fn display_information(app_name: &str) -> Value {
    json!({
        "name": app_name,
        "description": "Dedicated Lite Agents Slackbot",
        "background_color": "#000000",
        "long_description": "Lite Agents creates dedicated Slack apps for managed agents. This app routes Slack messages to one Claude managed agent, stores OAuth credentials in the Lite Agents vault, and may use large language models that can produce inaccurate or incomplete responses."
    })
}

fn features(app_name: &str) -> Value {
    json!({
        "app_home": {
            "home_tab_enabled": false,
            "messages_tab_enabled": true,
            "messages_tab_read_only_enabled": false
        },
        "bot_user": {
            "display_name": app_name,
            "always_online": false
        }
    })
}

fn slack_scopes() -> Vec<&'static str> {
    SLACK_SCOPES.split(',').collect()
}

fn encode_component(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}
