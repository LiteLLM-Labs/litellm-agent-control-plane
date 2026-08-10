use serde_json::json;

use super::{parse_sse, AgentEventKind, AgentEventPayload, SseParser};

#[test]
fn serde_roundtrip_keeps_flat_event_shape() {
    let events = parse_sse(
        "data: {\"type\":\"agent.message\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}\n\n",
    )
    .unwrap();

    assert_eq!(
        serde_json::to_value(&events[0]).unwrap(),
        json!({
            "type": "agent.message",
            "content": [{ "type": "text", "text": "hello" }]
        })
    );
}

#[test]
fn sse_event_name_supplies_missing_type() {
    let events = parse_sse(
        "event: agent.message\n\
         data: {\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}\n\n",
    )
    .unwrap();

    assert_eq!(events[0].kind(), AgentEventKind::AgentMessage);
}

#[test]
fn payload_type_wins_over_sse_event_name() {
    let events = parse_sse(
        "event: interaction_update\n\
         data: {\"type\":\"agent.message\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}\n\n",
    )
    .unwrap();

    assert_eq!(events[0].kind(), AgentEventKind::AgentMessage);
}

#[test]
fn unknown_events_preserve_fields() {
    let events = parse_sse("data: {\"type\":\"runtime.future\",\"x\":1}\n\n").unwrap();

    assert_eq!(
        events[0].payload(),
        AgentEventPayload::Unknown {
            event_type: "runtime.future".to_owned(),
            data: [("x".to_owned(), json!(1))].into_iter().collect(),
        }
    );
}

#[test]
fn typed_payload_keeps_extra_fields() {
    let events = parse_sse(
        "data: {\"type\":\"agent.tool_use\",\"id\":\"call_1\",\"name\":\"edit\",\"input\":{\"path\":\"README.md\"},\"processed_at\":\"now\"}\n\n",
    )
    .unwrap();

    let AgentEventPayload::AgentToolUse(payload) = events[0].payload() else {
        panic!("expected tool use payload");
    };
    assert_eq!(payload.id.as_deref(), Some("call_1"));
    assert_eq!(payload.name.as_deref(), Some("edit"));
    assert_eq!(payload.raw["processed_at"], json!("now"));
}

#[test]
fn streaming_parser_buffers_split_utf8_code_points() {
    let input = concat!(
        "event: agent.message\n",
        "data: {\"content\":[{\"type\":\"text\",\"text\":\"market – verified\"}]}\n\n"
    );
    let split = input.find('–').unwrap() + 1;
    let mut parser = SseParser::default();

    assert!(parser.push(&input.as_bytes()[..split]).unwrap().is_empty());
    let events = parser.push(&input.as_bytes()[split..]).unwrap();

    assert_eq!(events.len(), 1);
    let AgentEventPayload::AgentMessage(payload) = events[0].payload() else {
        panic!("expected agent message payload");
    };
    assert_eq!(payload.content[0]["text"], json!("market – verified"));
}
