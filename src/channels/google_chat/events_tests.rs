use serde_json::{json, Value};

use super::{agent_runtime, can_start_session, incoming_message_for_app};
use crate::{
    channels::google_chat::types::{
        GoogleChatEvent, GoogleChatIncomingMessage, GoogleChatMessageMode,
    },
    db::managed_agents::registry::schema::ManagedAgentRow,
    sdk::agents::CLAUDE_MANAGED_AGENTS,
};

#[test]
fn incoming_message_ignores_space_lifecycle_events() {
    for event_type in ["ADDED_TO_SPACE", "REMOVED_FROM_SPACE"] {
        let result = incoming_message(event(json!({
            "type": event_type,
            "space": { "name": "spaces/AAA", "type": "ROOM" }
        })));
        assert!(result.is_none());
    }
}

#[test]
fn incoming_message_ignores_card_clicked_event_with_message() {
    let result = incoming_message(event(json!({
        "type": "CARD_CLICKED",
        "message": {
            "name": "spaces/AAA/messages/msg-1",
            "text": "button click",
            "space": { "name": "spaces/AAA", "type": "DM" }
        },
        "space": { "name": "spaces/AAA", "type": "DM" }
    })));

    assert!(result.is_none());
}

#[test]
fn incoming_message_ignores_bot_sender() {
    let via_event_user = incoming_message(event(json!({
        "type": "MESSAGE",
        "user": { "name": "users/bot-1", "type": "BOT" },
        "message": {
            "name": "spaces/AAA/messages/msg-1",
            "text": "hello",
            "space": { "name": "spaces/AAA", "type": "DM" }
        },
        "space": { "name": "spaces/AAA", "type": "DM" }
    })));

    let via_sender = incoming_message(event(json!({
        "type": "MESSAGE",
        "message": {
            "name": "spaces/AAA/messages/msg-2",
            "text": "hello",
            "sender": { "name": "users/bot-1", "type": "BOT" },
            "space": { "name": "spaces/AAA", "type": "DM" }
        },
        "space": { "name": "spaces/AAA", "type": "DM" }
    })));

    assert!(via_event_user.is_none());
    assert!(via_sender.is_none());
}

#[test]
fn incoming_message_dm_uses_space_as_conversation_key() {
    let result = incoming_message(event(json!({
        "type": "MESSAGE",
        "user": { "name": "users/human-1", "type": "HUMAN" },
        "message": {
            "name": "spaces/AAA/messages/msg-1",
            "text": "hello",
            "space": { "name": "spaces/AAA", "type": "DM" },
            "thread": { "name": "spaces/AAA/threads/thread-1" }
        },
        "space": { "name": "spaces/AAA", "type": "DM" }
    })))
    .unwrap();

    assert_eq!(result.mode, GoogleChatMessageMode::DirectMessage);
    assert_eq!(result.conversation_key, "spaces/AAA");
    assert_eq!(result.space_name, "spaces/AAA");
}

#[test]
fn incoming_message_accepts_rest_direct_message_space_type() {
    let result = incoming_message(event(json!({
        "type": "MESSAGE",
        "user": { "name": "users/human-1", "type": "HUMAN" },
        "message": {
            "name": "spaces/AAA/messages/msg-1",
            "text": "hello",
            "space": { "name": "spaces/AAA", "spaceType": "DIRECT_MESSAGE" }
        },
        "space": { "name": "spaces/AAA", "spaceType": "DIRECT_MESSAGE" }
    })))
    .unwrap();

    assert_eq!(result.mode, GoogleChatMessageMode::DirectMessage);
    assert_eq!(result.conversation_key, "spaces/AAA");
}

#[test]
fn incoming_message_space_mention_uses_thread_as_conversation_key() {
    let result = incoming_message(event(json!({
        "type": "MESSAGE",
        "user": { "name": "users/human-1", "type": "HUMAN" },
        "message": {
            "name": "spaces/ROOM/messages/msg-1",
            "text": "<users/app> do the thing",
            "space": { "name": "spaces/ROOM", "type": "ROOM" },
            "thread": { "name": "spaces/ROOM/threads/thread-42" },
            "annotations": [
                { "type": "USER_MENTION", "userMention": { "user": {
                    "name": "users/app", "displayName": "YourAgent", "type": "BOT"
                }}}
            ]
        },
        "space": { "name": "spaces/ROOM", "type": "ROOM" }
    })))
    .unwrap();

    assert_eq!(result.mode, GoogleChatMessageMode::ChannelMention);
    assert_eq!(result.prompt, "do the thing");
    assert_eq!(result.conversation_key, "spaces/ROOM/threads/thread-42");
    assert_eq!(
        result.thread_name.as_deref(),
        Some("spaces/ROOM/threads/thread-42")
    );
}

#[test]
fn incoming_message_uses_event_thread_when_message_thread_is_missing() {
    let result = incoming_message_for_app(
        event(json!({
            "type": "MESSAGE",
            "user": { "name": "users/human-1", "type": "HUMAN" },
            "message": {
                "name": "spaces/ROOM/messages/msg-1",
                "text": "@Bot do the thing",
                "space": { "name": "spaces/ROOM", "spaceType": "SPACE" },
                "annotations": [
                    { "type": "USER_MENTION", "userMention": { "user": {
                        "name": "users/app", "displayName": "DifferentName", "type": "BOT"
                    }}}
                ]
            },
            "space": { "name": "spaces/ROOM", "spaceType": "SPACE" },
            "thread": { "name": "spaces/ROOM/threads/thread-root" }
        })),
        Some("YourAgent"),
    )
    .unwrap();

    assert_eq!(result.mode, GoogleChatMessageMode::ChannelMention);
    assert_eq!(result.conversation_key, "spaces/ROOM/threads/thread-root");
    assert_eq!(
        result.thread_name.as_deref(),
        Some("spaces/ROOM/threads/thread-root")
    );
}

#[test]
fn incoming_message_human_mention_is_channel_message() {
    let result = incoming_message_for_app(
        event(json!({
            "type": "MESSAGE",
            "user": { "name": "users/human-1", "type": "HUMAN" },
            "message": {
                "name": "spaces/ROOM/messages/msg-1",
                "text": "@Alice can you check this?",
                "space": { "name": "spaces/ROOM", "type": "ROOM" },
                "thread": { "name": "spaces/ROOM/threads/thread-7" },
                "annotations": [{ "type": "USER_MENTION", "userMention": { "user": {
                    "name": "users/human-2", "displayName": "Alice", "type": "HUMAN"
                }}}]
            },
            "space": { "name": "spaces/ROOM", "type": "ROOM" }
        })),
        Some("YourAgent"),
    )
    .unwrap();

    assert_eq!(result.mode, GoogleChatMessageMode::ChannelMessage);
}

#[test]
fn incoming_message_unbound_space_message_without_mention_is_channel_message() {
    let result = incoming_message(event(json!({
        "type": "MESSAGE",
        "user": { "name": "users/human-1", "type": "HUMAN" },
        "message": {
            "name": "spaces/ROOM/messages/msg-1",
            "text": "general update",
            "space": { "name": "spaces/ROOM", "type": "ROOM" },
            "thread": { "name": "spaces/ROOM/threads/thread-99" }
        },
        "space": { "name": "spaces/ROOM", "type": "ROOM" }
    })))
    .unwrap();

    assert_eq!(result.mode, GoogleChatMessageMode::ChannelMessage);
    assert_eq!(result.conversation_key, "spaces/ROOM/threads/thread-99");
}

#[test]
fn incoming_message_channel_message_without_thread_falls_back_to_space() {
    let result = incoming_message(event(json!({
        "type": "MESSAGE",
        "user": { "name": "users/human-1", "type": "HUMAN" },
        "message": {
            "name": "spaces/ROOM/messages/msg-1",
            "text": "general update",
            "space": { "name": "spaces/ROOM", "type": "ROOM" }
        },
        "space": { "name": "spaces/ROOM", "type": "ROOM" }
    })))
    .unwrap();

    assert_eq!(result.mode, GoogleChatMessageMode::ChannelMessage);
    assert_eq!(result.conversation_key, "spaces/ROOM");
    assert!(result.thread_name.is_none());
}

#[test]
fn channel_messages_do_not_start_sessions() {
    assert!(!can_start_session(&incoming(
        GoogleChatMessageMode::ChannelMessage
    )));
}

#[test]
fn direct_messages_and_mentions_can_start_sessions() {
    assert!(can_start_session(&incoming(
        GoogleChatMessageMode::DirectMessage
    )));
    assert!(can_start_session(&incoming(
        GoogleChatMessageMode::ChannelMention
    )));
}

#[test]
fn agent_runtime_defaults_to_claude_managed_agents() {
    assert_eq!(agent_runtime(&agent(json!({}))), CLAUDE_MANAGED_AGENTS);
    assert_eq!(
        agent_runtime(&agent(json!({ "runtime": " cursor " }))),
        "cursor"
    );
}

fn event(value: Value) -> GoogleChatEvent {
    serde_json::from_value(value).unwrap()
}

fn incoming_message(event: GoogleChatEvent) -> Option<GoogleChatIncomingMessage> {
    incoming_message_for_app(event, None)
}

fn agent(config: Value) -> ManagedAgentRow {
    ManagedAgentRow {
        id: "agent-1".to_owned(),
        name: "Agent".to_owned(),
        model: "openai/gpt-5-mini".to_owned(),
        system: "system".to_owned(),
        tools: json!([]),
        cadence: None,
        interval_seconds: None,
        session_id: Some("session-1".to_owned()),
        loop_id: None,
        created_at: 0,
        prompt: None,
        cron: None,
        timezone: "UTC".to_owned(),
        vault_keys: json!([]),
        setup_commands: json!([]),
        max_runtime_minutes: 30,
        on_failure: "pause".to_owned(),
        config,
        owner_id: None,
        status: "active".to_owned(),
        description: None,
        harness: CLAUDE_MANAGED_AGENTS.to_owned(),
        skill_ids: json!([]),
        rule_ids: json!([]),
    }
}

fn incoming(mode: GoogleChatMessageMode) -> GoogleChatIncomingMessage {
    GoogleChatIncomingMessage {
        message_name: "spaces/AAA/messages/msg-xyz".to_owned(),
        space_name: "spaces/AAA".to_owned(),
        thread_name: Some("spaces/AAA/threads/thread-1".to_owned()),
        conversation_key: "spaces/AAA/threads/thread-1".to_owned(),
        user_name: Some("users/human-1".to_owned()),
        prompt: "hello".to_owned(),
        mode,
    }
}
