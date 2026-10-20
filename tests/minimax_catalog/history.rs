use serde_json::{json, Value};

pub fn messages_history() -> Value {
    json!([
        {"role": "user", "content": [{"type": "image", "source": {
            "type": "url", "url": "https://example.com/image.png"
        }}]},
        {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "prior reasoning", "signature": "preserve"},
            {"type": "tool_use", "id": "call_1", "name": "lookup", "input": {}}
        ]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "call_1", "content": "ok"}]}
    ])
}

pub fn responses_history() -> Value {
    json!([
        {"role": "user", "content": [
            {"type": "input_image", "image_url": "https://example.com/image.png"},
            {"type": "input_video", "video_url": "https://example.com/video.mp4"}
        ]},
        {"type": "reasoning", "id": "reasoning_1", "summary": [], "encrypted_content": "preserve"},
        {"type": "function_call", "call_id": "call_1", "name": "lookup", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "call_1", "output": "ok"}
    ])
}
