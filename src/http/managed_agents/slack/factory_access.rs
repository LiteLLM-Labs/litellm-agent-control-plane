use serde_json::{json, Value};

use super::{types::SlackIncomingMessage, user_ids::normalize_slack_user_id};

const INVALID_DM_ALLOWLIST_SENTINEL: &str = "__invalid_dm_allowlist__";

pub(super) fn auto_connect_arguments(child_id: &str, message: &SlackIncomingMessage) -> Value {
    json!({
        "agent_id": child_id,
        "team_id": message.team_id,
        "channel_id": message.channel,
        "thread_ts": message.thread_ts,
        "dm_user_id": message.user_id,
        "requested_by": message.user_id,
        "allowed_dm_user_ids": requested_dm_allowlist(message),
    })
}

fn requested_dm_allowlist(message: &SlackIncomingMessage) -> Vec<String> {
    if !dm_limit_requested(&message.user_prompt) {
        return Vec::new();
    }
    let mut ids = explicit_slack_user_ids(&message.user_prompt);
    if ids.is_empty() && mentions_requester_only(&message.user_prompt) {
        if let Some(user_id) = message.user_id.as_ref() {
            ids.push(user_id.to_owned());
        }
    }
    if ids.is_empty() {
        ids.push(INVALID_DM_ALLOWLIST_SENTINEL.to_owned());
    }
    ids
}

fn dm_limit_requested(prompt: &str) -> bool {
    let lower = prompt.to_ascii_lowercase();
    let names_dms = names_direct_messages(&lower);
    let restricts = [
        "only",
        "limit",
        "restrict",
        "allowed",
        "allowlist",
        "whitelist",
        "specific",
    ]
    .iter()
    .any(|word| lower.contains(word));
    names_dms && restricts
}

fn names_direct_messages(lower_prompt: &str) -> bool {
    let mut previous = "";
    for word in lower_prompt
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
    {
        if matches!(word, "dm" | "dms")
            || (previous == "direct" && matches!(word, "message" | "messages"))
        {
            return true;
        }
        previous = word;
    }
    false
}

fn mentions_requester_only(prompt: &str) -> bool {
    let lower = prompt.to_ascii_lowercase();
    lower.contains("only me") || lower.contains("only i ") || lower.ends_with("only i")
}

fn explicit_slack_user_ids(prompt: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for token in prompt.split(char::is_whitespace) {
        let Some(id) = normalize_slack_user_id(token) else {
            continue;
        };
        if !ids.iter().any(|existing| existing == &id) {
            ids.push(id);
        }
    }
    ids
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{auto_connect_arguments, SlackIncomingMessage, INVALID_DM_ALLOWLIST_SENTINEL};

    fn message(prompt: &str, user_id: Option<&str>) -> SlackIncomingMessage {
        SlackIncomingMessage {
            channel: "C123".to_owned(),
            thread_ts: "1.000001".to_owned(),
            reply_thread_ts: "1.000001".to_owned(),
            team_id: Some("T123".to_owned()),
            user_id: user_id.map(str::to_owned),
            user_prompt: prompt.to_owned(),
            prompt: prompt.to_owned(),
            is_direct_message: false,
            requires_existing_thread: false,
        }
    }

    #[test]
    fn auto_connect_includes_dm_allowlist_from_slack_users() {
        let arguments = auto_connect_arguments(
            "agent_child",
            &message("build one; only <@U123> and U456 can DM it", Some("U999")),
        );

        assert_eq!(arguments["allowed_dm_user_ids"], json!(["U123", "U456"]));
    }

    #[test]
    fn auto_connect_uses_requester_for_only_me_dm_limits() {
        let arguments = auto_connect_arguments(
            "agent_child",
            &message(
                "create this and only me can direct message it",
                Some("U999"),
            ),
        );

        assert_eq!(arguments["allowed_dm_user_ids"], json!(["U999"]));
    }

    #[test]
    fn auto_connect_keeps_dms_open_without_limit_request() {
        let arguments = auto_connect_arguments(
            "agent_child",
            &message(
                "create an agent that can summarize DMs from <@U123>",
                Some("U999"),
            ),
        );

        assert_eq!(arguments["allowed_dm_user_ids"], json!([]));
    }

    #[test]
    fn auto_connect_does_not_treat_admin_as_dm_limit() {
        let arguments = auto_connect_arguments(
            "agent_child",
            &message("create an agent only for admin tasks", Some("U999")),
        );

        assert_eq!(arguments["allowed_dm_user_ids"], json!([]));
    }

    #[test]
    fn auto_connect_does_not_treat_indirect_messages_as_dm_limit() {
        let arguments = auto_connect_arguments(
            "agent_child",
            &message("create an agent only for indirect messages", Some("U999")),
        );

        assert_eq!(arguments["allowed_dm_user_ids"], json!([]));
    }

    #[test]
    fn auto_connect_fails_closed_when_limit_has_no_slack_ids() {
        let arguments = auto_connect_arguments(
            "agent_child",
            &message("create it, but only Bob can DM it", Some("U999")),
        );

        assert_eq!(
            arguments["allowed_dm_user_ids"],
            json!([INVALID_DM_ALLOWLIST_SENTINEL])
        );
    }

    #[test]
    fn auto_connect_ignores_generated_session_prompt_dm_guidance() {
        let mut message = message("create an inbox triage agent", Some("U999"));
        message.prompt = concat!(
            "Slack context for platform tools:\n",
            "If the user asks to limit who can DM the new agent, ",
            "pass allowed_dm_user_ids with those Slack user IDs.\n\n",
            "create an inbox triage agent"
        )
        .to_owned();

        let arguments = auto_connect_arguments("agent_child", &message);

        assert_eq!(arguments["allowed_dm_user_ids"], json!([]));
    }
}
