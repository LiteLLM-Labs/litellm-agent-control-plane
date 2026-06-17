use axum::{http::StatusCode, Json};
use serde::Serialize;

#[derive(Serialize)]
pub struct NavItem {
    pub key: &'static str,
    pub label: &'static str,
    pub icon: &'static str,
    pub path: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badge: Option<bool>,
}

#[derive(Serialize)]
pub struct PluginManifest {
    pub name: &'static str,
    pub display_name: &'static str,
    pub version: &'static str,
    pub nav_items: Vec<NavItem>,
    pub capabilities: Vec<&'static str>,
}

pub async fn plugin_manifest() -> Result<Json<PluginManifest>, StatusCode> {
    Ok(Json(PluginManifest {
        name: "litellm-platform-plugin",
        display_name: "Agent Control Plane",
        version: env!("CARGO_PKG_VERSION"),
        nav_items: vec![
            NavItem { key: "acp-sessions",     label: "Sessions",       icon: "MessageOutlined",      path: "/sessions",     badge: None },
            NavItem { key: "acp-agents",       label: "Agents",         icon: "RobotOutlined",        path: "/agents",       badge: None },
            NavItem { key: "acp-routines",     label: "Routines",       icon: "ClockCircleOutlined",  path: "/routines",     badge: None },
            NavItem { key: "acp-inbox",        label: "Inbox",          icon: "InboxOutlined",        path: "/inbox",        badge: Some(true) },
            NavItem { key: "acp-skills",       label: "Skills",         icon: "ThunderboltOutlined",  path: "/skills",       badge: None },
            NavItem { key: "acp-rules",        label: "Rules",          icon: "SafetyOutlined",       path: "/rules",        badge: None },
            NavItem { key: "acp-vault",        label: "Vault",          icon: "LockOutlined",         path: "/vault",        badge: None },
            NavItem { key: "acp-integrations", label: "Integrations",   icon: "PlugOutlined",         path: "/integrations", badge: None },
            NavItem { key: "acp-runtimes",     label: "Agent Runtimes", icon: "ToolOutlined",         path: "/runtimes",     badge: None },
            NavItem { key: "acp-mcp-servers",  label: "MCP Servers",    icon: "ApiOutlined",          path: "/mcp-servers",  badge: None },
            NavItem { key: "acp-providers",    label: "LLM Providers",  icon: "DatabaseOutlined",     path: "/providers",    badge: None },
        ],
        capabilities: vec!["agents", "routines", "mcp", "sessions", "runtimes"],
    }))
}
