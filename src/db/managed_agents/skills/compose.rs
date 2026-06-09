use serde_json::Value;
use sqlx::PgPool;

use crate::{
    db::managed_agents::{
        registry::schema::ManagedAgentRow,
        rules::{self, schema::RuleRow},
        skills::{self, schema::SkillRow},
    },
    errors::GatewayError,
};

/// Compose an agent's downstream system prompt: the agent's own base system
/// prompt first, followed by the full bodies of the skills **attached to this
/// agent** (by `skill_ids`). Skills the agent has not attached are never
/// included — the system prompt must not enumerate other agents' skills.
///
/// This is the single source of truth for skill → system-prompt composition. It
/// is shared by the non-runtime agent-run path (`runs/create/definition.rs`) and
/// the `claude_managed_agents` runtime session path (`http/sessions/runtime.rs`)
/// so both surfaces send an identical system prompt to the model.
pub async fn compose_agent_system_prompt(
    pool: &PgPool,
    agent: &ManagedAgentRow,
) -> Result<String, GatewayError> {
    let attached_skill_ids = string_array(&agent.skill_ids);
    if attached_skill_ids.is_empty() {
        return compose_agent_rules_prompt(pool, agent, agent.system.trim().to_owned()).await;
    }
    let all_skills = skills::repository::list(pool, None).await?;
    let attached_skills = all_skills
        .iter()
        .filter(|skill| attached_skill_ids.iter().any(|id| id == &skill.id))
        .collect::<Vec<_>>();
    compose_agent_rules_prompt(
        pool,
        agent,
        compose_agent_system(&agent.system, &attached_skills),
    )
    .await
}

/// Extract a JSON array of strings (the agent's `skill_ids`) into a `Vec<String>`.
pub fn string_array(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect()
}

fn compose_agent_system(agent_system: &str, attached_skills: &[&SkillRow]) -> String {
    let mut parts = Vec::new();
    if !agent_system.trim().is_empty() {
        parts.push(agent_system.trim().to_owned());
    }
    parts.extend(
        attached_skills
            .iter()
            .map(|skill| format!("## Skill: {}\n{}", skill.name, skill.content)),
    );
    parts.join("\n\n---\n\n")
}

async fn compose_agent_rules_prompt(
    pool: &PgPool,
    agent: &ManagedAgentRow,
    system: String,
) -> Result<String, GatewayError> {
    let attached_rule_ids = string_array(&agent.rule_ids);
    if attached_rule_ids.is_empty() {
        return Ok(system);
    }
    let all_rules = rules::repository::list(pool, None).await?;
    let attached_rules = all_rules
        .iter()
        .filter(|rule| attached_rule_ids.iter().any(|id| id == &rule.id))
        .collect::<Vec<_>>();
    Ok(compose_agent_rules(&system, &attached_rules))
}

fn compose_agent_rules(agent_system: &str, attached_rules: &[&RuleRow]) -> String {
    let mut parts = Vec::new();
    if !agent_system.trim().is_empty() {
        parts.push(agent_system.trim().to_owned());
    }
    if !attached_rules.is_empty() {
        let rules = attached_rules
            .iter()
            .map(|rule| format!("### {}\n{}", rule.name, rule.content))
            .collect::<Vec<_>>()
            .join("\n\n");
        parts.push(format!("## Attached Rules\n{rules}"));
    }
    parts.join("\n\n---\n\n")
}
