use std::error::Error;

#[path = "managed_agents_support/raw_sse.rs"]
mod raw_sse;

#[path = "managed_agents_support/live_compare.rs"]
mod live_compare;

#[tokio::test]
#[ignore = "requires ANTHROPIC_API_KEY and creates real Claude Managed Agents resources"]
async fn anthropic_live_raw_stream_compare() -> Result<(), Box<dyn Error>> {
    live_compare::anthropic_live_raw_stream_compare().await
}

#[tokio::test]
#[ignore = "requires CURSOR_API_KEY and creates a real Cursor Cloud Agent"]
async fn cursor_live_raw_stream_compare() -> Result<(), Box<dyn Error>> {
    live_compare::cursor_live_raw_stream_compare().await
}
