use std::fmt;

use super::AgentSdkError;

pub const CLAUDE_MANAGED_AGENTS: &str = "claude_managed_agents";
pub const CURSOR: &str = "cursor";
pub const GEMINI_ANTIGRAVITY: &str = "gemini_antigravity";
pub const OPENCODE: &str = "opencode";
pub const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
pub const DEFAULT_CURSOR_BASE_URL: &str = "https://api.cursor.com";
pub const DEFAULT_GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com";
pub const DEFAULT_OPENCODE_BASE_URL: &str = "http://127.0.0.1:4096";
pub const GEMINI_API_REVISION: &str = "2026-05-20";
pub const MANAGED_AGENTS_BETA: &str = "managed-agents-2026-04-01";
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentRuntime {
    ClaudeManagedAgents,
    Cursor,
    GeminiAntigravity,
    OpenCode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentRuntimeCatalogEntry {
    pub runtime: AgentRuntime,
    pub id: &'static str,
    pub name: &'static str,
    pub default_api_base: &'static str,
}

impl AgentRuntime {
    pub const CATALOG: [AgentRuntimeCatalogEntry; 4] = [
        AgentRuntimeCatalogEntry {
            runtime: Self::ClaudeManagedAgents,
            id: CLAUDE_MANAGED_AGENTS,
            name: "Claude Agents",
            default_api_base: DEFAULT_ANTHROPIC_BASE_URL,
        },
        AgentRuntimeCatalogEntry {
            runtime: Self::Cursor,
            id: CURSOR,
            name: "Cursor",
            default_api_base: DEFAULT_CURSOR_BASE_URL,
        },
        AgentRuntimeCatalogEntry {
            runtime: Self::GeminiAntigravity,
            id: GEMINI_ANTIGRAVITY,
            name: "Gemini Antigravity",
            default_api_base: DEFAULT_GEMINI_BASE_URL,
        },
        AgentRuntimeCatalogEntry {
            runtime: Self::OpenCode,
            id: OPENCODE,
            name: "OpenCode",
            default_api_base: DEFAULT_OPENCODE_BASE_URL,
        },
    ];

    pub fn catalog() -> &'static [AgentRuntimeCatalogEntry] {
        &Self::CATALOG
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeManagedAgents => CLAUDE_MANAGED_AGENTS,
            Self::Cursor => CURSOR,
            Self::GeminiAntigravity => GEMINI_ANTIGRAVITY,
            Self::OpenCode => OPENCODE,
        }
    }

    pub fn name(self) -> &'static str {
        Self::catalog()
            .iter()
            .find(|entry| entry.runtime == self)
            .map(|entry| entry.name)
            .unwrap_or_else(|| self.as_str())
    }

    pub fn default_api_base(self) -> &'static str {
        Self::catalog()
            .iter()
            .find(|entry| entry.runtime == self)
            .map(|entry| entry.default_api_base)
            .unwrap_or_default()
    }
}

impl TryFrom<&str> for AgentRuntime {
    type Error = AgentSdkError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            CLAUDE_MANAGED_AGENTS => Ok(Self::ClaudeManagedAgents),
            CURSOR => Ok(Self::Cursor),
            GEMINI_ANTIGRAVITY => Ok(Self::GeminiAntigravity),
            OPENCODE => Ok(Self::OpenCode),
            runtime => Err(AgentSdkError::UnsupportedRuntime(runtime.to_owned())),
        }
    }
}

impl fmt::Display for AgentRuntime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}
