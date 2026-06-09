use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db::managed_agents::{
        registry,
        skills::{
            repository as skills_repository,
            schema::{SkillRow, UpdateSkill},
        },
    },
    errors::GatewayError,
};

use super::required_str;

pub async fn edit_agent_skill(
    pool: &PgPool,
    agent_id: &str,
    arguments: Value,
) -> Result<Value, GatewayError> {
    let agent = registry::repository::get(pool, agent_id)
        .await?
        .ok_or_else(|| GatewayError::UnknownAgent(agent_id.to_owned()))?;
    let attached_skill_ids = string_array(&agent.skill_ids);
    match required_str(&arguments, "action")? {
        "list" => {
            let skills = attached_skills(pool, &attached_skill_ids).await?;
            Ok(json!({ "skills": skills }))
        }
        "get" => {
            let skill_id = resolve_skill_id(&arguments, &attached_skill_ids)?;
            if !attached_skill_ids.iter().any(|id| id == &skill_id) {
                return Ok(unattached_skill_error(attached_skill_ids));
            }
            let skill = attached_skill(pool, &attached_skill_ids, &skill_id).await?;
            Ok(json!({ "skill": skill }))
        }
        "update" => {
            let skill_id = resolve_skill_id(&arguments, &attached_skill_ids)?;
            if !attached_skill_ids.iter().any(|id| id == &skill_id) {
                return Ok(unattached_skill_error(attached_skill_ids));
            }
            attached_skill(pool, &attached_skill_ids, &skill_id).await?;
            let input = skill_update(&arguments)?;
            let skill = skills_repository::update(pool, &skill_id, input)
                .await?
                .ok_or_else(|| GatewayError::NotFound("skill not found".to_owned()))?;
            Ok(json!({ "skill": skill, "status": "updated" }))
        }
        action => Err(GatewayError::InvalidJsonMessage(format!(
            "unsupported skill action: {action}"
        ))),
    }
}

async fn attached_skills(
    pool: &PgPool,
    attached_skill_ids: &[String],
) -> Result<Vec<SkillRow>, GatewayError> {
    let mut skills = Vec::new();
    for skill_id in attached_skill_ids {
        if let Some(skill) = skills_repository::get(pool, skill_id).await? {
            skills.push(skill);
        }
    }
    Ok(skills)
}

async fn attached_skill(
    pool: &PgPool,
    attached_skill_ids: &[String],
    skill_id: &str,
) -> Result<SkillRow, GatewayError> {
    if !attached_skill_ids.iter().any(|id| id == skill_id) {
        return Err(GatewayError::InvalidJsonMessage(
            "skill is not attached to this agent".to_owned(),
        ));
    }
    skills_repository::get(pool, skill_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound("skill not found".to_owned()))
}

fn resolve_skill_id(
    arguments: &Value,
    attached_skill_ids: &[String],
) -> Result<String, GatewayError> {
    if let Some(skill_id) = arguments
        .get("skill_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        return Ok(skill_id.to_owned());
    }
    match attached_skill_ids {
        [skill_id] => Ok(skill_id.clone()),
        [] => Err(GatewayError::InvalidJsonMessage(
            "this agent has no attached skills".to_owned(),
        )),
        _ => Err(GatewayError::InvalidJsonMessage(
            "skill_id is required when multiple skills are attached".to_owned(),
        )),
    }
}

fn skill_update(arguments: &Value) -> Result<UpdateSkill, GatewayError> {
    let input = UpdateSkill {
        name: optional_string(arguments, "name"),
        content: optional_string(arguments, "content"),
        description: optional_string(arguments, "description"),
    };
    if input.name.is_none() && input.content.is_none() && input.description.is_none() {
        return Err(GatewayError::InvalidJsonMessage(
            "one of name, content, or description is required".to_owned(),
        ));
    }
    Ok(input)
}

fn optional_string(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn string_array(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn unattached_skill_error(attached_skill_ids: Vec<String>) -> Value {
    json!({
        "isError": true,
        "message": "skill is not attached to this agent",
        "attached_skill_ids": attached_skill_ids
    })
}
