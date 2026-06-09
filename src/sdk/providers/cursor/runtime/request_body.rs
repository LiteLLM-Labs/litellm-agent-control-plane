use serde_json::{json, Map, Value};

use crate::sdk::agents::{AgentModel, CreateAgentParams};

pub(super) fn create_agent_body(params: CreateAgentParams) -> Value {
    let mut body = Map::new();
    body.insert("prompt".to_owned(), json!({ "text": params.system }));
    body.insert("name".to_owned(), Value::String(params.name));
    body.insert("model".to_owned(), model(params.model));
    if let Some(workspace) = params.workspace {
        if !workspace.repository.is_empty() {
            let ref_name = workspace.ref_name.as_deref().unwrap_or("main");
            body.insert(
                "repos".to_owned(),
                json!([{ "url": workspace.repository, "startingRef": ref_name }]),
            );
        }
        body.insert("autoCreatePR".to_owned(), Value::Bool(workspace.auto_create_pr));
    }
    if !params.mcp_servers.is_empty() {
        body.insert(
            "mcpServers".to_owned(),
            Value::Array(params.mcp_servers.into_iter().map(mcp_server).collect()),
        );
    }
    Value::Object(body)
}

fn model(model: AgentModel) -> Value {
    match model {
        AgentModel::Id(id) => json!({ "id": id }),
        AgentModel::Config(config) => {
            let mut model = Map::new();
            model.insert("id".to_owned(), Value::String(config.id));
            if let Some(speed) = config.speed {
                model.insert(
                    "params".to_owned(),
                    json!([{ "id": "speed", "value": speed }]),
                );
            }
            Value::Object(model)
        }
    }
}

fn mcp_server(server: Value) -> Value {
    let mut server = match server {
        Value::Object(server) => server,
        _ => Map::new(),
    };
    match server.get("type").and_then(Value::as_str) {
        Some("url") | None => {
            server.insert("type".to_owned(), Value::String("http".to_owned()));
        }
        _ => {}
    }
    Value::Object(server)
}
