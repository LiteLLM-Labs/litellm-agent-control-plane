use std::path::PathBuf;

use futures_util::stream;
use tokio::{io::AsyncReadExt, process::Command, sync::mpsc};

use crate::{
    agents::{
        config::E2bSandboxParams,
        sandboxes::{boxed_stream, AgentOutputChunk, AgentOutputStream, SandboxCommand},
    },
    errors::GatewayError,
};

pub const PROVIDER: &str = "server";

#[derive(Debug, Clone)]
pub struct LocalSandboxClient {
    settings: E2bSandboxParams,
}

#[derive(Debug, Clone)]
pub struct LocalSandbox {
    pub id: String,
    pub workspace_dir: PathBuf,
}

impl LocalSandboxClient {
    pub fn new(settings: E2bSandboxParams) -> Self {
        Self { settings }
    }

    pub async fn create(&self, run_id: &str) -> Result<LocalSandbox, GatewayError> {
        let workspace_dir = std::env::temp_dir().join("litellm-agent-runs").join(run_id);
        tokio::fs::create_dir_all(&workspace_dir)
            .await
            .map_err(|error| GatewayError::SandboxError(error.to_string()))?;
        Ok(LocalSandbox {
            id: run_id.to_owned(),
            workspace_dir,
        })
    }

    pub async fn start_command(
        &self,
        sandbox: &LocalSandbox,
        command: SandboxCommand,
    ) -> Result<AgentOutputStream, GatewayError> {
        let mut child = Command::new("bash")
            .arg("-lc")
            .arg(&command.command)
            .current_dir(&sandbox.workspace_dir)
            .envs(&self.settings.envs)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|error| GatewayError::SandboxError(error.to_string()))?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let (tx, rx) = mpsc::channel(32);

        if let Some(stdout) = stdout {
            spawn_reader(stdout, tx.clone(), AgentOutputChunk::stdout);
        }
        if let Some(stderr) = stderr {
            spawn_reader(stderr, tx.clone(), AgentOutputChunk::stderr);
        }

        tokio::spawn(async move {
            match child.wait().await {
                Ok(status) if status.success() => {}
                Ok(status) => {
                    let _ = tx
                        .send(Err(GatewayError::SandboxError(format!(
                            "local process exited with status {status}"
                        ))))
                        .await;
                }
                Err(error) => {
                    let _ = tx
                        .send(Err(GatewayError::SandboxError(error.to_string())))
                        .await;
                }
            }
        });

        Ok(boxed_stream(stream::unfold(rx, |mut rx| async {
            rx.recv().await.map(|item| (item, rx))
        })))
    }

    pub async fn terminate(&self, _sandbox_id: &str) -> Result<(), GatewayError> {
        Ok(())
    }
}

fn spawn_reader<R>(
    mut reader: R,
    tx: mpsc::Sender<Result<AgentOutputChunk, GatewayError>>,
    chunk: fn(String) -> AgentOutputChunk,
) where
    R: AsyncReadExt + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(n) => {
                    let delta = String::from_utf8_lossy(&buffer[..n]).into_owned();
                    if tx.send(Ok(chunk(delta))).await.is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = tx
                        .send(Err(GatewayError::SandboxError(error.to_string())))
                        .await;
                    break;
                }
            }
        }
    });
}
