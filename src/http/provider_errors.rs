use serde_json::Value;

use crate::{errors::GatewayError, sdk::agents::AgentSdkError};

const MAX_PROVIDER_ERROR_CHARS: usize = 500;

pub(crate) fn agent_sdk_error(error: AgentSdkError) -> GatewayError {
    GatewayError::SandboxError(agent_sdk_error_message(error))
}

pub(crate) fn agent_sdk_error_message(error: AgentSdkError) -> String {
    match error {
        AgentSdkError::Provider { status, body } => managed_agent_provider_message(status, &body),
        other => other.to_string(),
    }
}

pub(crate) fn managed_agent_provider_message(status: reqwest::StatusCode, body: &str) -> String {
    let detail = provider_body_summary(body);
    if detail.is_empty() {
        format!("managed agent provider request failed with status {status}")
    } else {
        format!("managed agent provider request failed with status {status}: {detail}")
    }
}

fn provider_body_summary(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if let Some(message) = json_error_message(trimmed) {
        return text_summary(&message);
    }

    text_summary(trimmed)
}

fn json_error_message(body: &str) -> Option<String> {
    let parsed = serde_json::from_str::<Value>(body).ok()?;
    parsed
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
        })
        .or_else(|| parsed.get("message").and_then(Value::as_str))
        .or_else(|| parsed.get("detail").and_then(Value::as_str))
        .map(str::to_owned)
}

fn text_summary(text: &str) -> String {
    let compact = if looks_like_html_document(text) {
        compact_whitespace(&strip_html_document(text))
    } else {
        compact_whitespace(text)
    };
    truncate_chars(&compact, MAX_PROVIDER_ERROR_CHARS)
}

fn looks_like_html_document(text: &str) -> bool {
    let sample = text
        .chars()
        .take(500)
        .collect::<String>()
        .to_ascii_lowercase();
    sample.contains("<!doctype html") || sample.contains("<html") || sample.contains("<body")
}

fn strip_html_document(text: &str) -> String {
    let without_blocks = ["head", "style", "script", "svg"]
        .into_iter()
        .fold(text.to_owned(), |current, tag| {
            remove_html_blocks(current, tag)
        });
    let mut result = String::with_capacity(without_blocks.len());
    let mut in_tag = false;
    for ch in without_blocks.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                result.push(' ');
            }
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    result
}

fn remove_html_blocks(mut text: String, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut search_from = 0;
    loop {
        let lower = text.to_ascii_lowercase();
        let Some(start) = find_tag_start(&lower, &open, search_from) else {
            break;
        };
        let after_open = match lower[start..].find('>') {
            Some(offset) => start + offset + 1,
            None => {
                text.replace_range(start.., " ");
                break;
            }
        };
        let end = match lower[after_open..].find(&close) {
            Some(offset) => after_open + offset + close.len(),
            None => text.len(),
        };
        text.replace_range(start..end, " ");
        search_from = start;
    }
    text
}

fn find_tag_start(lower: &str, open: &str, from: usize) -> Option<usize> {
    let mut search_from = from;
    loop {
        let relative_start = lower[search_from..].find(open)?;
        let start = search_from + relative_start;
        let after_open = start + open.len();
        let boundary = lower[after_open..]
            .chars()
            .next()
            .map(|ch| ch == '>' || ch.is_ascii_whitespace())
            .unwrap_or(false);
        if boundary {
            return Some(start);
        }
        search_from = after_open;
    }
}

fn compact_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let mut truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        truncated.push_str("...");
    }
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_json_error_message_is_extracted() {
        let message = managed_agent_provider_message(
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"error":{"message":"bad key"}}"#,
        );

        assert_eq!(
            message,
            "managed agent provider request failed with status 401 Unauthorized: bad key"
        );
    }

    #[test]
    fn provider_html_error_body_is_summarized() {
        let message = managed_agent_provider_message(
            reqwest::StatusCode::BAD_GATEWAY,
            r#"<!DOCTYPE html>
<html>
  <head>
    <title>502</title>
    <style>@font-face { src: url("data:font/woff2;base64,abcdef"); }</style>
    <script>alert("nope")</script>
  </head>
  <body>
    <header>
      <svg><title>502</title><path d="M30 92"></path></svg>
      <h1>Bad Gateway</h1>
    </header>
    <main>
      <div class="request-id">Request ID: a0cbecd538690055-PDX</div>
      <div>This service is currently unavailable. Please try again in a few minutes.</div>
    </main>
  </body>
</html>"#,
        );

        assert!(message.contains("Bad Gateway"), "{message}");
        assert!(
            message.contains("Request ID: a0cbecd538690055-PDX"),
            "{message}"
        );
        assert!(
            message.contains("This service is currently unavailable"),
            "{message}"
        );
        assert!(!message.contains("<!DOCTYPE"), "{message}");
        assert!(!message.contains("@font-face"), "{message}");
        assert!(!message.contains("data:font"), "{message}");
        assert!(!message.contains("alert"), "{message}");
    }

    #[test]
    fn nested_html_error_message_is_summarized() {
        let message = managed_agent_provider_message(
            reqwest::StatusCode::BAD_GATEWAY,
            r#"{"error":{"message":"<!doctype html><html><body><h1>Bad Gateway</h1></body></html>"}}"#,
        );

        assert_eq!(
            message,
            "managed agent provider request failed with status 502 Bad Gateway: Bad Gateway"
        );
    }

    #[test]
    fn long_provider_error_body_is_truncated() {
        let body = "x".repeat(MAX_PROVIDER_ERROR_CHARS + 10);
        let message = managed_agent_provider_message(reqwest::StatusCode::BAD_GATEWAY, &body);

        assert!(message.ends_with("..."));
        assert!(message.len() < MAX_PROVIDER_ERROR_CHARS + 100);
    }
}
