use std::collections::HashMap;

mod connect;

use futures_util::{stream, StreamExt, TryStreamExt};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::{
    agents::{
        config::E2bSandboxParams,
        sandboxes::{boxed_stream, AgentOutputStream, SandboxCommand},
    },
    errors::GatewayError,
};

use self::connect::{connect_json_frame, ConnectJsonDecoder};

pub const PROVIDER: &str = "e2b";

#[derive(Debug, Clone)]
pub struct E2bSandboxClient {
    http: Client,
    settings: E2bSandboxParams,
}

#[derive(Debug, Clone)]
pub struct E2bSandbox {
    pub id: String,
    access_token: String,
    process_base_url: String,
}

impl E2bSandboxClient {
    pub fn new(http: Client, settings: E2bSandboxParams) -> Self {
        Self { http, settings }
    }

    pub async fn create(&self, run_id: &str) -> Result<E2bSandbox, GatewayError> {
        let api_key = self.api_key()?;
        let response = self
            .http
            .post(format!(
                "{}/sandboxes",
                self.settings.e2b_api_base.trim_end_matches('/')
            ))
            .header("X-API-Key", api_key)
            .json(&CreateSandboxRequest {
                template_id: &self.settings.e2b_template,
                timeout: self.settings.timeout_seconds,
                secure: true,
                allow_internet_access: true,
                metadata: SandboxMetadata { run_id },
            })
            .send()
            .await
            .map_err(GatewayError::Sandbox)?;

        if !response.status().is_success() {
            return Err(GatewayError::SandboxError(format!(
                "E2B create sandbox failed with status {}",
                response.status()
            )));
        }

        let created: CreateSandboxResponse =
            response.json().await.map_err(GatewayError::Sandbox)?;
        let access_token = created.envd_access_token.ok_or_else(|| {
            GatewayError::SandboxError(
                "E2B create sandbox did not return envdAccessToken".to_owned(),
            )
        })?;
        let process_base_url = created
            .domain
            .filter(|domain| !domain.trim().is_empty())
            .unwrap_or_else(|| format!("https://49983-{}.e2b.app", created.sandbox_id));

        Ok(E2bSandbox {
            id: created.sandbox_id,
            access_token,
            process_base_url,
        })
    }

    pub async fn start_command(
        &self,
        sandbox: &E2bSandbox,
        command: SandboxCommand,
    ) -> Result<AgentOutputStream, GatewayError> {
        let command = command_with_workspace(&self.settings.workspace_dir, &command.command);
        let response = self
            .http
            .post(format!(
                "{}/process.Process/Start",
                sandbox.process_base_url.trim_end_matches('/')
            ))
            .header("X-Access-Token", &sandbox.access_token)
            .header("Authorization", "Basic dXNlcjo=")
            .header("Connect-Protocol-Version", "1")
            .header("Content-Type", "application/connect+json")
            .body(connect_json_frame(&StartProcessRequest {
                process: StartProcess {
                    cmd: "bash",
                    args: vec!["-lc", &command],
                    cwd: "/",
                    envs: &self.settings.envs,
                },
                stdin: false,
            })?)
            .send()
            .await
            .map_err(GatewayError::Sandbox)?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(GatewayError::SandboxError(format!(
                "E2B start process failed with status {status}: {body}"
            )));
        }

        let mut decoder = ConnectJsonDecoder::default();
        let stream = response.bytes_stream().map(move |bytes| {
            bytes
                .map_err(GatewayError::Sandbox)
                .map(|bytes| decoder.decode(bytes))
        });
        let stream = stream
            .map_ok(|chunks| stream::iter(chunks.into_iter().map(Ok)))
            .try_flatten();

        Ok(boxed_stream(stream))
    }

    pub async fn terminate(&self, sandbox_id: &str) -> Result<(), GatewayError> {
        let api_key = self.api_key()?;
        let response = self
            .http
            .delete(format!(
                "{}/sandboxes/{}",
                self.settings.e2b_api_base.trim_end_matches('/'),
                sandbox_id
            ))
            .header("X-API-Key", api_key)
            .send()
            .await
            .map_err(GatewayError::Sandbox)?;

        if !response.status().is_success() {
            return Err(GatewayError::SandboxError(format!(
                "E2B terminate sandbox failed with status {}",
                response.status()
            )));
        }

        Ok(())
    }

    fn api_key(&self) -> Result<&str, GatewayError> {
        self.settings
            .e2b_api_key
            .as_deref()
            .filter(|key| !key.trim().is_empty())
            .ok_or_else(|| {
                GatewayError::InvalidConfig(
                    "general_settings.e2b_sandbox_params.e2b_api_key is required".to_owned(),
                )
            })
    }
}

fn command_with_workspace(workspace_dir: &str, command: &str) -> String {
    format!(
        "mkdir -p {} && cd {} && {}",
        shell_quote(workspace_dir),
        shell_quote(workspace_dir),
        command
    )
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[derive(Serialize)]
struct CreateSandboxRequest<'a> {
    #[serde(rename = "templateID")]
    template_id: &'a str,
    timeout: u64,
    secure: bool,
    allow_internet_access: bool,
    metadata: SandboxMetadata<'a>,
}

#[derive(Serialize)]
struct SandboxMetadata<'a> {
    run_id: &'a str,
}

#[derive(Deserialize)]
struct CreateSandboxResponse {
    #[serde(rename = "sandboxID")]
    sandbox_id: String,
    #[serde(rename = "envdAccessToken")]
    envd_access_token: Option<String>,
    domain: Option<String>,
}

#[derive(Serialize)]
struct StartProcessRequest<'a> {
    process: StartProcess<'a>,
    stdin: bool,
}

#[derive(Serialize)]
struct StartProcess<'a> {
    cmd: &'a str,
    args: Vec<&'a str>,
    cwd: &'a str,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    envs: &'a HashMap<String, String>,
}
