use std::sync::Arc;

use axum::{
    extract::State,
    response::{Html, IntoResponse, Redirect},
    Json,
};
use serde_json::{json, Value};

use crate::proxy::state::AppState;

pub async fn swagger_ui() -> Html<&'static str> {
    Html(include_str!("swagger.html"))
}

pub async fn openapi_json(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let models = configured_models(&state);
    let model_enum_desc = model_enum_description(&models);

    Json(openapi_spec(&models, &model_enum_desc))
}

fn configured_models(state: &AppState) -> Vec<Value> {
    state
        .config
        .model_list
        .iter()
        .map(|m| json!(m.model_name))
        .collect()
}

fn model_enum_description(models: &[Value]) -> String {
    models
        .iter()
        .filter_map(|v| v.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn openapi_spec(models: &[Value], model_enum_desc: &str) -> Value {
    json!({
        "openapi": "3.0.3",
        "info": {
            "title": "LiteLLM API",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "Low-overhead LiteLLM-compatible gateway"
        },
        "paths": {
            "/health": health_path(),
            "/v1/models": models_path(),
            "/api/capabilities": capabilities_path(),
            "/api/keys": keys_path(),
            "/api/keys/{id}": key_path(),
            "/v1/messages": messages_path(models, model_enum_desc)
        },
        "components": components()
    })
}

fn models_path() -> Value {
    json!({
        "get": {
            "summary": "List configured model aliases",
            "operationId": "listModels",
            "tags": ["Models"],
            "security": [{ "BearerAuth": [] }],
            "responses": {
                "200": { "description": "OpenAI-compatible model list" },
                "401": { "description": "Invalid or missing gateway key" }
            }
        }
    })
}

fn capabilities_path() -> Value {
    json!({
        "get": {
            "summary": "List gateway capabilities",
            "operationId": "getCapabilities",
            "tags": ["System"],
            "security": [{ "BearerAuth": [] }],
            "responses": {
                "200": { "description": "Providers, endpoints, MCP servers, and agents" },
                "401": { "description": "Invalid or missing gateway key" }
            }
        }
    })
}

fn keys_path() -> Value {
    json!({
        "get": {
            "summary": "List gateway API keys",
            "operationId": "listGatewayApiKeys",
            "tags": ["API Keys"],
            "security": [{ "BearerAuth": [] }],
            "responses": {
                "200": { "description": "API key metadata" },
                "401": { "description": "Invalid or missing gateway key" }
            }
        },
        "post": {
            "summary": "Create a gateway API key",
            "operationId": "createGatewayApiKey",
            "tags": ["API Keys"],
            "security": [{ "BearerAuth": [] }],
            "requestBody": {
                "required": true,
                "content": {
                    "application/json": {
                        "schema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string" }
                            }
                        }
                    }
                }
            },
            "responses": {
                "201": { "description": "Created API key. The secret is returned once." },
                "401": { "description": "Invalid or missing gateway key" }
            }
        }
    })
}

fn key_path() -> Value {
    json!({
        "delete": {
            "summary": "Delete a gateway API key",
            "operationId": "deleteGatewayApiKey",
            "tags": ["API Keys"],
            "security": [{ "BearerAuth": [] }],
            "parameters": [{
                "name": "id",
                "in": "path",
                "required": true,
                "schema": { "type": "string" }
            }],
            "responses": {
                "204": { "description": "Deleted" },
                "404": { "description": "API key not found" },
                "401": { "description": "Invalid or missing gateway key" }
            }
        }
    })
}

fn health_path() -> Value {
    json!({
        "get": {
            "summary": "Health check",
            "operationId": "health",
            "tags": ["System"],
            "responses": {
                "200": {
                    "description": "Server is healthy",
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "status": { "type": "string", "example": "ok" }
                                }
                            }
                        }
                    }
                }
            }
        }
    })
}

fn messages_path(models: &[Value], model_enum_desc: &str) -> Value {
    json!({
        "post": {
            "summary": "Create a message (Anthropic-compatible)",
            "operationId": "createMessage",
            "tags": ["Messages"],
            "security": [{ "BearerAuth": [] }],
            "requestBody": {
                "required": true,
                "content": {
                    "application/json": {
                        "schema": messages_schema(models, model_enum_desc)
                    }
                }
            },
            "responses": {
                "200": { "description": "Message response from upstream provider" },
                "401": { "description": "Invalid or missing master key" },
                "404": { "description": "Model not found in config" }
            }
        }
    })
}

fn messages_schema(models: &[Value], model_enum_desc: &str) -> Value {
    json!({
        "type": "object",
        "required": ["model", "messages", "max_tokens"],
        "properties": {
            "model": {
                "type": "string",
                "description": format!("Model alias from config. Available: {}", model_enum_desc),
                "example": models.first().and_then(|v| v.as_str()).unwrap_or("claude-sonnet")
            },
            "messages": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["role", "content"],
                    "properties": {
                        "role": { "type": "string", "enum": ["user", "assistant"] },
                        "content": { "type": "string" }
                    }
                },
                "example": [{ "role": "user", "content": "Hello!" }]
            },
            "max_tokens": { "type": "integer", "example": 1024 },
            "stream": { "type": "boolean", "example": false }
        }
    })
}

fn components() -> Value {
    json!({
        "securitySchemes": {
            "BearerAuth": {
                "type": "http",
                "scheme": "bearer",
                "description": "Your LITELLM_MASTER_KEY"
            }
        }
    })
}

pub async fn redirect_to_docs() -> Redirect {
    Redirect::permanent("/docs")
}
