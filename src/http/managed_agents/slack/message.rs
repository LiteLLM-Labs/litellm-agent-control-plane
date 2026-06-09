use serde_json::Value;

use super::types::SlackIncomingMessage;

pub(super) fn incoming_message(payload: &Value) -> Option<SlackIncomingMessage> {
    let event = payload.get("event")?;
    if event.get("bot_id").is_some() || event.get("subtype").is_some() {
        return None;
    }
    if !is_supported_event(event) {
        return None;
    }
    let channel = event.get("channel").and_then(Value::as_str)?.to_owned();
    Some(SlackIncomingMessage {
        thread_ts: session_thread_ts(event)?,
        reply_thread_ts: reply_thread_ts(event)?,
        channel,
        team_id: payload
            .get("team_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        user_id: event.get("user").and_then(Value::as_str).map(str::to_owned),
        prompt: clean_prompt(
            event
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        requires_existing_thread: is_thread_reply(event),
    })
}

pub(super) fn session_prompt(message: &SlackIncomingMessage) -> String {
    if !super::dispatch::is_factory_prompt(&message.prompt) {
        return message.prompt.clone();
    }
    let team_id = message.team_id.as_deref().unwrap_or("unknown");
    let user_id = message.user_id.as_deref().unwrap_or("unknown");
    format!(
        concat!(
            "Slack context for platform tools:\n",
            "- team_id: {team_id}\n",
            "- channel_id: {channel_id}\n",
            "- requested_by: {user_id}\n",
            "- thread_ts: {thread_ts}\n\n",
            "This request came from Slack. For every request to make, create, add, build, or install an agent, ",
            "create the agent and then immediately call connect_agent_to_slack with the created agent_id, ",
            "team_id, channel_id, thread_ts, and requested_by above. ",
            "Always connect the agent to Slack in this same turn unless the user explicitly says not to. ",
            "Do not call list_slack_agent_bindings before connecting. ",
            "When replying, include the connected status, agent_url, and reinstall_url if returned. ",
            "Explain that the reinstall_url grants Slack permission to show replies with the agent name. ",
            "Do not ask the user for these IDs.\n\n",
            "{prompt}"
        ),
        team_id = team_id,
        channel_id = message.channel,
        user_id = user_id,
        thread_ts = message.thread_ts,
        prompt = message.prompt,
    )
}

fn is_supported_event(event: &Value) -> bool {
    match event.get("type").and_then(Value::as_str) {
        Some("app_mention") => true,
        Some("message") => is_direct_message(event) || is_thread_reply(event),
        _ => false,
    }
}

fn session_thread_ts(event: &Value) -> Option<String> {
    reply_thread_ts(event)
}

fn reply_thread_ts(event: &Value) -> Option<String> {
    event
        .get("thread_ts")
        .or_else(|| event.get("ts"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn is_direct_message(event: &Value) -> bool {
    matches!(
        event.get("channel_type").and_then(Value::as_str),
        Some("im" | "mpim")
    )
}

fn is_thread_reply(event: &Value) -> bool {
    if event.get("type").and_then(Value::as_str) != Some("message") {
        return false;
    }
    let Some(thread_ts) = event.get("thread_ts").and_then(Value::as_str) else {
        return false;
    };
    let ts = event.get("ts").and_then(Value::as_str);
    ts != Some(thread_ts)
}

fn clean_prompt(text: &str) -> String {
    let prompt = text
        .split_whitespace()
        .filter(|part| !part.starts_with("<@"))
        .collect::<Vec<_>>()
        .join(" ");
    match prompt.trim() {
        "" => "Proceed with your task.".to_owned(),
        _ => prompt,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{incoming_message, session_prompt};

    #[test]
    fn direct_messages_use_message_thread() {
        let first = incoming_message(&json!({
            "team_id": "T123",
            "event": {
                "type": "message",
                "channel_type": "im",
                "user": "U123",
                "channel": "D123",
                "ts": "1.000001",
                "text": "hello"
            }
        }))
        .unwrap();
        let second = incoming_message(&json!({
            "team_id": "T123",
            "event": {
                "type": "message",
                "channel_type": "im",
                "user": "U123",
                "channel": "D123",
                "ts": "1.000002",
                "text": "again"
            }
        }))
        .unwrap();
        assert_eq!(first.thread_ts, "1.000001");
        assert_eq!(second.thread_ts, "1.000002");
        assert_eq!(first.reply_thread_ts, "1.000001");
        assert_eq!(second.reply_thread_ts, "1.000002");
        assert_eq!(first.team_id.as_deref(), Some("T123"));
        assert_eq!(first.user_id.as_deref(), Some("U123"));
    }

    #[test]
    fn direct_message_thread_replies_reuse_existing_thread() {
        let message = incoming_message(&json!({
            "team_id": "T123",
            "event": {
                "type": "message",
                "channel_type": "im",
                "user": "U123",
                "channel": "D123",
                "thread_ts": "1.000001",
                "ts": "1.000002",
                "text": "follow up"
            }
        }))
        .unwrap();
        assert_eq!(message.thread_ts, "1.000001");
        assert_eq!(message.reply_thread_ts, "1.000001");
        assert!(message.requires_existing_thread);
    }

    #[test]
    fn factory_prompts_include_slack_context() {
        let message = incoming_message(&json!({
            "team_id": "T123",
            "event": {
                "type": "message",
                "channel_type": "im",
                "user": "U123",
                "channel": "D123",
                "ts": "1.000001",
                "text": "make me an agent called Release Buddy"
            }
        }))
        .unwrap();
        let prompt = session_prompt(&message);
        assert!(prompt.contains("team_id: T123"));
        assert!(prompt.contains("channel_id: D123"));
        assert!(prompt.contains("requested_by: U123"));
        assert!(prompt.contains("Do not ask the user for these IDs."));
        assert!(prompt.contains("agent_url"));
        assert!(prompt.contains("make me an agent called Release Buddy"));
    }

    #[test]
    fn non_factory_prompts_do_not_include_slack_context() {
        let message = incoming_message(&json!({
            "team_id": "T123",
            "event": {
                "type": "message",
                "channel_type": "im",
                "user": "U123",
                "channel": "D123",
                "ts": "1.000001",
                "text": "summarize this thread"
            }
        }))
        .unwrap();
        assert_eq!(session_prompt(&message), "summarize this thread");
    }

    #[test]
    fn threaded_mentions_can_create_sessions() {
        let message = incoming_message(&json!({
            "event": {
                "type": "app_mention",
                "channel": "C123",
                "thread_ts": "1.000001",
                "ts": "1.000002",
                "text": "<@B123> handle this"
            }
        }))
        .unwrap();
        assert_eq!(message.thread_ts, "1.000001");
        assert_eq!(message.reply_thread_ts, "1.000001");
        assert!(!message.requires_existing_thread);
        assert_eq!(message.prompt, "handle this");
    }
}
