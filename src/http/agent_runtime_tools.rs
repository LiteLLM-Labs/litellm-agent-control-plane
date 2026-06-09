use serde::Serialize;

use crate::sdk::agents::{CLAUDE_MANAGED_AGENTS, CURSOR, GEMINI_ANTIGRAVITY, OPENCODE};

#[derive(Debug, Clone, Copy, Serialize)]
pub struct RuntimeTool {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub enabled_by_default: bool,
}

pub fn runtime_tools(runtime: &str) -> &'static [RuntimeTool] {
    match runtime {
        CLAUDE_MANAGED_AGENTS | "claude_agents" => &CLAUDE_MANAGED_TOOLS,
        GEMINI_ANTIGRAVITY => &GEMINI_ANTIGRAVITY_TOOLS,
        CURSOR | OPENCODE => &[],
        _ => &[],
    }
}

const CLAUDE_MANAGED_TOOLS: [RuntimeTool; 8] = [
    RuntimeTool {
        id: "bash",
        name: "Shell",
        description: "Run shell commands in the agent environment.",
        enabled_by_default: true,
    },
    RuntimeTool {
        id: "read",
        name: "Read files",
        description: "Read files from the agent environment.",
        enabled_by_default: true,
    },
    RuntimeTool {
        id: "write",
        name: "Write files",
        description: "Create or overwrite files in the agent environment.",
        enabled_by_default: true,
    },
    RuntimeTool {
        id: "edit",
        name: "Edit files",
        description: "Patch existing files in the agent environment.",
        enabled_by_default: true,
    },
    RuntimeTool {
        id: "glob",
        name: "Find files",
        description: "Find files by glob pattern.",
        enabled_by_default: true,
    },
    RuntimeTool {
        id: "grep",
        name: "Search files",
        description: "Search file contents by regular expression.",
        enabled_by_default: true,
    },
    RuntimeTool {
        id: "web_fetch",
        name: "Fetch URL",
        description: "Fetch content from a URL.",
        enabled_by_default: true,
    },
    RuntimeTool {
        id: "web_search",
        name: "Web search",
        description: "Search the web for information.",
        enabled_by_default: true,
    },
];

const GEMINI_ANTIGRAVITY_TOOLS: [RuntimeTool; 3] = [
    RuntimeTool {
        id: "code_execution",
        name: "Code execution",
        description: "Run code and shell commands in the managed sandbox.",
        enabled_by_default: true,
    },
    RuntimeTool {
        id: "google_search",
        name: "Google Search",
        description: "Search the public web.",
        enabled_by_default: true,
    },
    RuntimeTool {
        id: "url_context",
        name: "URL context",
        description: "Fetch and read web pages.",
        enabled_by_default: true,
    },
];
