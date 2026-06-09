use std::{
    error::Error,
    time::{SystemTime, UNIX_EPOCH},
};

use litellm_rust::sdk::agents::{ANTHROPIC_VERSION, MANAGED_AGENTS_BETA};
use reqwest::header;
use serde_json::{json, Value};

use crate::raw_sse::print_stream_until_terminal;

struct AnthropicLiveConfig {
    api_key: String,
    model: String,
    prompt: String,
    suffix: u64,
}

struct CursorLiveConfig {
    api_key: String,
    model: String,
    prompt: String,
    suffix: u64,
}

struct CursorRun {
    agent_id: String,
    run_id: String,
}

pub async fn anthropic_live_raw_stream_compare() -> Result<(), Box<dyn Error>> {
    let config = anthropic_live_config()?;
    let client = reqwest::Client::new();
    let agent_id = create_anthropic_agent(&client, &config).await?;
    println!("anthropic resource agent_id={agent_id}");

    let environment_id = create_anthropic_environment(&client, &config).await?;
    println!("anthropic resource environment_id={environment_id}");

    let session_id = create_anthropic_session(&client, &config, &agent_id, &environment_id).await?;
    println!("anthropic resource session_id={session_id}");

    let response = open_anthropic_stream(&client, &config.api_key, &session_id).await?;
    send_anthropic_prompt(&client, &config, &session_id).await?;
    print_stream_until_terminal("anthropic", response).await
}

pub async fn cursor_live_raw_stream_compare() -> Result<(), Box<dyn Error>> {
    let config = cursor_live_config()?;
    let client = reqwest::Client::new();
    let run = create_cursor_agent(&client, &config).await?;
    println!("cursor resource agent_id={}", run.agent_id);
    println!("cursor resource run_id={}", run.run_id);

    let response = open_cursor_stream(&client, &config.api_key, &run).await?;
    let result = print_stream_until_terminal("cursor", response).await;
    archive_cursor_agent(&client, &config.api_key, &run.agent_id).await;
    result
}

fn anthropic_live_config() -> Result<AnthropicLiveConfig, Box<dyn Error>> {
    Ok(AnthropicLiveConfig {
        api_key: std::env::var("ANTHROPIC_API_KEY")
            .map_err(|_| "ANTHROPIC_API_KEY must be set for the Anthropic live stream compare")?,
        model: std::env::var("ANTHROPIC_MODEL").unwrap_or_else(|_| "claude-sonnet-4-6".to_owned()),
        prompt: std::env::var("STREAM_COMPARE_PROMPT").unwrap_or_else(|_| {
            "Reply with exactly: LAP managed agents stream compare ok.".to_owned()
        }),
        suffix: timestamp_suffix()?,
    })
}

fn cursor_live_config() -> Result<CursorLiveConfig, Box<dyn Error>> {
    Ok(CursorLiveConfig {
        api_key: std::env::var("CURSOR_API_KEY")
            .map_err(|_| "CURSOR_API_KEY must be set for the Cursor live stream compare")?,
        model: std::env::var("CURSOR_MODEL").unwrap_or_else(|_| "default".to_owned()),
        prompt: std::env::var("STREAM_COMPARE_PROMPT").unwrap_or_else(|_| {
            "Reply with exactly: LAP cursor stream compare ok. Do not modify files.".to_owned()
        }),
        suffix: timestamp_suffix()?,
    })
}

async fn create_anthropic_agent(
    client: &reqwest::Client,
    config: &AnthropicLiveConfig,
) -> Result<String, Box<dyn Error>> {
    let response = anthropic_headers(
        client.post("https://api.anthropic.com/v1/agents"),
        &config.api_key,
    )
    .json(&json!({
        "name": format!("LAP SDK stream compare {}", config.suffix),
        "model": &config.model,
        "system": "Follow the user's request exactly.",
        "tools": [{ "type": "agent_toolset_20260401" }]
    }))
    .send()
    .await?
    .error_for_status()?
    .json::<Value>()
    .await?;
    required_string(&response, "id")
}

async fn create_anthropic_environment(
    client: &reqwest::Client,
    config: &AnthropicLiveConfig,
) -> Result<String, Box<dyn Error>> {
    let response = anthropic_headers(
        client.post("https://api.anthropic.com/v1/environments"),
        &config.api_key,
    )
    .json(&json!({
        "name": format!("lap-stream-compare-{}", config.suffix),
        "config": {
            "type": "cloud",
            "networking": { "type": "unrestricted" }
        }
    }))
    .send()
    .await?
    .error_for_status()?
    .json::<Value>()
    .await?;
    required_string(&response, "id")
}

async fn create_anthropic_session(
    client: &reqwest::Client,
    config: &AnthropicLiveConfig,
    agent_id: &str,
    environment_id: &str,
) -> Result<String, Box<dyn Error>> {
    let response = anthropic_headers(
        client.post("https://api.anthropic.com/v1/sessions"),
        &config.api_key,
    )
    .json(&json!({
        "agent": agent_id,
        "environment_id": environment_id,
        "title": "LAP SDK stream compare"
    }))
    .send()
    .await?
    .error_for_status()?
    .json::<Value>()
    .await?;
    required_string(&response, "id")
}

async fn open_anthropic_stream(
    client: &reqwest::Client,
    api_key: &str,
    session_id: &str,
) -> Result<reqwest::Response, Box<dyn Error>> {
    Ok(anthropic_headers(
        client.get(format!(
            "https://api.anthropic.com/v1/sessions/{session_id}/events/stream"
        )),
        api_key,
    )
    .header(header::ACCEPT, "text/event-stream")
    .send()
    .await?
    .error_for_status()?)
}

async fn send_anthropic_prompt(
    client: &reqwest::Client,
    config: &AnthropicLiveConfig,
    session_id: &str,
) -> Result<(), Box<dyn Error>> {
    anthropic_headers(
        client.post(format!(
            "https://api.anthropic.com/v1/sessions/{session_id}/events"
        )),
        &config.api_key,
    )
    .json(&json!({
        "events": [{
            "type": "user.message",
            "content": [{ "type": "text", "text": &config.prompt }]
        }]
    }))
    .send()
    .await?
    .error_for_status()?;
    Ok(())
}

async fn create_cursor_agent(
    client: &reqwest::Client,
    config: &CursorLiveConfig,
) -> Result<CursorRun, Box<dyn Error>> {
    let created = client
        .post("https://api.cursor.com/v1/agents")
        .bearer_auth(&config.api_key)
        .json(&json!({
            "name": format!("LAP SDK stream compare {}", config.suffix),
            "model": { "id": &config.model },
            "prompt": { "text": &config.prompt }
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    Ok(CursorRun {
        agent_id: required_nested_string(&created, "agent", "id")?,
        run_id: required_nested_string(&created, "run", "id")?,
    })
}

async fn open_cursor_stream(
    client: &reqwest::Client,
    api_key: &str,
    run: &CursorRun,
) -> Result<reqwest::Response, Box<dyn Error>> {
    Ok(client
        .get(format!(
            "https://api.cursor.com/v1/agents/{}/runs/{}/stream",
            run.agent_id, run.run_id
        ))
        .bearer_auth(api_key)
        .header(header::ACCEPT, "text/event-stream")
        .send()
        .await?
        .error_for_status()?)
}

async fn archive_cursor_agent(client: &reqwest::Client, api_key: &str, agent_id: &str) {
    let cleanup = client
        .post(format!(
            "https://api.cursor.com/v1/agents/{agent_id}/archive"
        ))
        .bearer_auth(api_key)
        .send()
        .await;
    if let Err(error) = cleanup {
        eprintln!("cursor cleanup failed for {agent_id}: {error}");
    }
}

fn anthropic_headers(request: reqwest::RequestBuilder, api_key: &str) -> reqwest::RequestBuilder {
    request
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", MANAGED_AGENTS_BETA)
}

fn required_string(value: &Value, field: &'static str) -> Result<String, Box<dyn Error>> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("missing field {field} in {value}").into())
}

fn required_nested_string(
    value: &Value,
    parent: &'static str,
    field: &'static str,
) -> Result<String, Box<dyn Error>> {
    value
        .get(parent)
        .and_then(|value| value.get(field))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("missing field {parent}.{field} in {value}").into())
}

fn timestamp_suffix() -> Result<u64, Box<dyn Error>> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}
