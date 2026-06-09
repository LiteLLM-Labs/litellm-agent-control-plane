use serde_json::Value;

use crate::sdk::agents::AgentEvent;

pub(super) fn runtime_text(event: &AgentEvent) -> Option<String> {
    event
        .data
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| event.data.get("delta").and_then(Value::as_str))
        .or_else(|| nested_str(&event.data, "delta", "text"))
        .or_else(|| nested_str(&event.data, "part", "text"))
        .map(str::to_owned)
        .or_else(|| content_text(event.data.get("content")?))
        .or_else(|| content_text(event.data.get("message")?.get("content")?))
}

pub(super) fn slack_mrkdwn(text: &str) -> String {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed == "---" {
            out.push("-----".to_owned());
            continue;
        }
        if let Some(heading) = markdown_heading(trimmed) {
            out.push(format!("*{}*", heading.replace("**", "")));
            continue;
        }
        out.push(line.replace("**", "*"));
    }
    out.join("\n")
}

pub(super) fn runtime_status(event: &AgentEvent) -> Option<&str> {
    event
        .data
        .get("status")
        .and_then(Value::as_str)
        .or_else(|| nested_str(&event.data, "status", "type"))
}

fn content_text(value: &Value) -> Option<String> {
    let blocks = value.as_array()?;
    let text = blocks
        .iter()
        .filter_map(|block| {
            block
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| block.get("content").and_then(Value::as_str))
        })
        .collect::<Vec<_>>()
        .join("");
    (!text.is_empty()).then_some(text)
}

fn markdown_heading(line: &str) -> Option<&str> {
    let hashes = line.chars().take_while(|char| *char == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    line.get(hashes..)?.strip_prefix(' ').map(str::trim)
}

fn nested_str<'a>(
    data: &'a serde_json::Map<String, Value>,
    parent: &str,
    field: &str,
) -> Option<&'a str> {
    data.get(parent)
        .and_then(Value::as_object)
        .and_then(|value| value.get(field))
        .and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::slack_mrkdwn;

    #[test]
    fn formats_common_markdown_for_slack() {
        let input = "# About Me\n\nI'm **Claude**.\n\n## What I Am\n---";
        assert_eq!(
            slack_mrkdwn(input),
            "*About Me*\n\nI'm *Claude*.\n\n*What I Am*\n-----"
        );
    }
}
