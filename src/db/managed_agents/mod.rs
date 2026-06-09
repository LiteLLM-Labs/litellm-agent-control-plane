pub mod files;
pub mod harnesses;
pub mod inbox;
pub mod loops;
pub mod memory;
pub mod messages;
pub mod pool;
pub mod registry;
pub mod routines;
pub mod rules;
pub mod runs;
pub mod runtime_events;
pub mod runtime_refs;
pub mod saved;
pub mod sessions;
pub mod settings;
pub mod skills;
pub mod slack;
pub mod spend_logs;

pub fn id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
