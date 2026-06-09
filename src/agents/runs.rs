use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tokio::sync::broadcast;

const MAX_STORED_EVENTS: usize = 1024;
const MAX_STORED_EVENT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRunStatus {
    Starting,
    Running,
    Completed,
    Failed,
    TimedOut,
}

impl AgentRunStatus {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::TimedOut)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentRun {
    pub id: String,
    pub agent_id: String,
    pub status: AgentRunStatus,
    pub started_at: u128,
    pub finished_at: Option<u128>,
    pub sandbox_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug)]
struct StoredRun {
    run: AgentRun,
}

pub struct AgentEventStream {
    pub snapshot: Vec<String>,
    pub rx: broadcast::Receiver<String>,
}

#[derive(Debug)]
pub struct AgentRunStore {
    runs: Mutex<HashMap<String, StoredRun>>,
    events: Mutex<StoredEvents>,
    counter: AtomicU64,
}

#[derive(Debug)]
struct StoredEvents {
    events: VecDeque<String>,
    bytes: usize,
    tx: broadcast::Sender<String>,
}

impl Default for AgentRunStore {
    fn default() -> Self {
        let (tx, _) = broadcast::channel(1024);
        Self {
            runs: Mutex::new(HashMap::new()),
            events: Mutex::new(StoredEvents {
                events: VecDeque::new(),
                bytes: 0,
                tx,
            }),
            counter: AtomicU64::new(0),
        }
    }
}

impl AgentRunStore {
    pub fn create_run(&self, agent_id: &str) -> AgentRun {
        let id = format!(
            "run_{}_{:x}",
            now_millis(),
            self.counter.fetch_add(1, Ordering::Relaxed)
        );
        self.track_run(agent_id, &id)
    }

    pub fn track_run(&self, agent_id: &str, run_id: &str) -> AgentRun {
        let run = AgentRun {
            id: run_id.to_owned(),
            agent_id: agent_id.to_owned(),
            status: AgentRunStatus::Starting,
            started_at: now_millis(),
            finished_at: None,
            sandbox_id: None,
            error: None,
        };

        self.runs()
            .insert(run_id.to_owned(), StoredRun { run: run.clone() });

        run
    }

    pub fn list_runs(&self, agent_id: &str) -> Vec<AgentRun> {
        self.runs()
            .values()
            .filter(|stored| stored.run.agent_id == agent_id)
            .map(|stored| stored.run.clone())
            .collect()
    }

    pub fn get_run(&self, run_id: &str) -> Option<AgentRun> {
        self.runs().get(run_id).map(|stored| stored.run.clone())
    }

    pub fn event_stream(&self) -> AgentEventStream {
        let events = self.events();
        AgentEventStream {
            snapshot: events.events.iter().cloned().collect(),
            rx: events.tx.subscribe(),
        }
    }

    pub fn update_status(&self, run_id: &str, status: AgentRunStatus) {
        if let Some(stored) = self.runs().get_mut(run_id) {
            stored.run.status = status;
            if status.is_terminal() {
                stored.run.finished_at = Some(now_millis());
            }
        }
    }

    pub fn set_sandbox_id(&self, run_id: &str, sandbox_id: String) {
        if let Some(stored) = self.runs().get_mut(run_id) {
            stored.run.sandbox_id = Some(sandbox_id);
        }
    }

    pub fn set_error(&self, run_id: &str, error: String) {
        if let Some(stored) = self.runs().get_mut(run_id) {
            stored.run.error = Some(error);
            stored.run.status = AgentRunStatus::Failed;
            stored.run.finished_at = Some(now_millis());
        }
    }

    pub fn push_event(&self, run_id: &str, event: &str, data: impl Serialize) {
        let Ok(mut payload) = serde_json::to_value(data) else {
            return;
        };

        let Some(agent_id) = self
            .runs()
            .get(run_id)
            .map(|stored| stored.run.agent_id.clone())
        else {
            return;
        };

        if let Some(payload) = payload.as_object_mut() {
            payload.insert("agent_id".to_owned(), agent_id.into());
            payload.insert("run_id".to_owned(), run_id.to_owned().into());
            payload.insert("sessionID".to_owned(), run_id.to_owned().into());
        }
        let Some(line) = event_line(event, payload) else {
            return;
        };

        let mut events = self.events();
        events.bytes += line.len();
        events.events.push_back(line.clone());
        while events.events.len() > MAX_STORED_EVENTS || events.bytes > MAX_STORED_EVENT_BYTES {
            if let Some(removed) = events.events.pop_front() {
                events.bytes = events.bytes.saturating_sub(removed.len());
            } else {
                events.bytes = 0;
                break;
            }
        }
        let _ = events.tx.send(line);
    }

    fn runs(&self) -> MutexGuard<'_, HashMap<String, StoredRun>> {
        self.runs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn events(&self) -> MutexGuard<'_, StoredEvents> {
        self.events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub fn event_line(event: &str, properties: serde_json::Value) -> Option<String> {
    let payload = serde_json::to_string(&serde_json::json!({
        "type": event,
        "properties": properties,
    }))
    .ok()?;
    Some(format!("data: {payload}\n\n"))
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
