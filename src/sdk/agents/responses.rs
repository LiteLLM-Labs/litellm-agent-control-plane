use serde_json::Value;

use super::AgentSdkError;

pub(crate) async fn response_json(response: reqwest::Response) -> Result<Value, AgentSdkError> {
    let response = ensure_success(response).await?;
    let text = response.text().await?;
    if text.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_str(&text).map_err(AgentSdkError::Json)
}

pub(crate) async fn ensure_success(
    response: reqwest::Response,
) -> Result<reqwest::Response, AgentSdkError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    Err(AgentSdkError::Provider { status, body })
}
