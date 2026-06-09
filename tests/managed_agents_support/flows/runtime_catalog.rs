use super::{request_json, AppFixture};

pub async fn assert_agent_runtime_catalog(fixture: &AppFixture) {
    let response = request_json(fixture.app.clone(), "GET", "/api/agent-runtimes", None).await;
    let runtimes = response["runtimes"].as_array().unwrap();
    let ids: Vec<_> = runtimes
        .iter()
        .map(|runtime| runtime["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec![
            "claude_managed_agents",
            "cursor",
            "gemini_antigravity",
            "opencode"
        ]
    );
    assert!(!ids.contains(&"claude_agents"));
    assert_eq!(
        runtimes[2]["default_api_base"],
        "https://generativelanguage.googleapis.com"
    );
    assert_eq!(runtimes[3]["default_api_base"], "http://127.0.0.1:4096");
    assert_eq!(runtimes[0]["credential_provider_id"], "anthropic");
    assert_eq!(runtimes[1]["credential_provider_id"], "cursor");
    assert_eq!(runtimes[2]["credential_provider_id"], "gemini");
    assert_eq!(runtimes[3]["credential_provider_id"], "opencode");
    assert_runtime_tools(runtimes);
}

fn assert_runtime_tools(runtimes: &[serde_json::Value]) {
    let claude_tools: Vec<_> = runtimes[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        claude_tools,
        vec![
            "bash",
            "read",
            "write",
            "edit",
            "glob",
            "grep",
            "web_fetch",
            "web_search"
        ]
    );
    let gemini_tools: Vec<_> = runtimes[2]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        gemini_tools,
        vec!["code_execution", "google_search", "url_context"]
    );
    assert!(runtimes[3]["tools"].as_array().unwrap().is_empty());
}
