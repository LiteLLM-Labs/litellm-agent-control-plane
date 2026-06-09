use super::AgentRuntime;

#[derive(Debug, thiserror::Error)]
pub enum AgentSdkError {
    #[error("unsupported lap_agent_runtime: {0}")]
    UnsupportedRuntime(String),
    #[error("no agent runtimes configured")]
    NoRuntimesConfigured,
    #[error("lap_agent_runtime is required when multiple runtimes are configured")]
    RuntimeRequired,
    #[error("{0} runtime is not configured")]
    RuntimeNotConfigured(AgentRuntime),
    #[error("provider request failed with status {status}: {body}")]
    Provider {
        status: reqwest::StatusCode,
        body: String,
    },
    #[error("provider response is missing id")]
    MissingId,
    #[error("provider response is missing {0}")]
    MissingField(&'static str),
    #[error("invalid managed agent SDK request: {0}")]
    InvalidRequest(String),
    #[error("managed agent SDK state lock failed")]
    StateLock,
    #[error("http client error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("utf8 error: {0}")]
    Utf8(#[from] std::str::Utf8Error),
}
