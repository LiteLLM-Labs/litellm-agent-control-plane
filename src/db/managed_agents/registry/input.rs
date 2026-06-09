use serde_json::{json, Value};

use crate::errors::GatewayError;

use super::schema::{CreateManagedAgent, UpdateManagedAgent};

pub(super) fn validate_create(input: &CreateManagedAgent) -> Result<(), GatewayError> {
    if input.name.trim().is_empty() || input.owner_id.trim().is_empty() {
        return Err(GatewayError::InvalidJsonMessage(
            "name and owner_id required".to_owned(),
        ));
    }
    validate_runtime(input.runtime.as_deref())
}

pub(super) fn validate_update(input: &UpdateManagedAgent) -> Result<(), GatewayError> {
    validate_runtime(input.runtime.as_deref())
}

pub(super) fn create_config(config: Option<Value>, runtime: Option<&str>, tools: &Value) -> Value {
    let mut config = config
        .filter(|value| value.is_object())
        .unwrap_or_else(|| json!({}));
    let Some(object) = config.as_object_mut() else {
        return json!({});
    };
    if let Some(runtime) = runtime.filter(|runtime| !runtime.trim().is_empty()) {
        object.insert("runtime".to_owned(), runtime.to_owned().into());
    }
    if !tools.is_null() {
        object.insert("tools".to_owned(), tools.clone());
    }
    config
}

fn validate_runtime(runtime: Option<&str>) -> Result<(), GatewayError> {
    if runtime.is_some_and(|runtime| runtime.trim().is_empty()) {
        return Err(GatewayError::InvalidJsonMessage(
            "runtime cannot be empty".to_owned(),
        ));
    }
    Ok(())
}
