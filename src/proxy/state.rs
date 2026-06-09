use std::sync::{Arc, RwLock};

use reqwest::Client;
use sqlx::PgPool;

use crate::{
    agents::{locks::KeyedLockStore, runs::AgentRunStore},
    callbacks::{litellm_db::LiteLLMDBCallback, CallbackManager},
    errors::GatewayError,
    mcp::registry::McpServerRegistry,
    model_prices::ModelCostMap,
    proxy::{auth::api_keys::GatewayApiKeyStore, config::GatewayConfig},
    sdk::routing::Router,
};

#[derive(Debug)]
pub struct AppState {
    pub config: GatewayConfig,
    pub router: Router,
    pub mcp_servers: McpServerRegistry,
    pub http: Client,
    pub model_cost_map: ModelCostMap,
    pub agent_runs: AgentRunStore,
    pub keyed_locks: KeyedLockStore,
    pub db: Option<PgPool>,
    pub api_keys: GatewayApiKeyStore,
    pub callbacks: CallbackManager,
    mcp_proxy_base_url: RwLock<Option<String>>,
}

impl AppState {
    pub fn build_http_client() -> Result<Client, GatewayError> {
        Client::builder()
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .tcp_nodelay(true)
            .http2_adaptive_window(true)
            .build()
            .map_err(GatewayError::HttpClient)
    }

    pub fn new(
        config: GatewayConfig,
        router: Router,
        http: Client,
        model_cost_map: ModelCostMap,
        db: Option<PgPool>,
    ) -> Result<Self, GatewayError> {
        let callbacks = callbacks(&config, db.clone());
        Ok(Self {
            mcp_servers: McpServerRegistry::from_config(&config)?,
            config,
            router,
            http,
            model_cost_map,
            agent_runs: AgentRunStore::default(),
            keyed_locks: KeyedLockStore::default(),
            db,
            api_keys: GatewayApiKeyStore::default(),
            callbacks,
            mcp_proxy_base_url: RwLock::new(None),
        })
    }

    pub fn set_mcp_proxy_base_url_override(&self, value: Option<String>) {
        if let Ok(mut guard) = self.mcp_proxy_base_url.write() {
            *guard = value;
        }
    }

    pub fn mcp_proxy_base_url_override(&self) -> Option<String> {
        self.mcp_proxy_base_url
            .read()
            .ok()
            .and_then(|value| value.clone())
    }

    pub fn configured_mcp_proxy_base_url(&self) -> Option<String> {
        self.config
            .mcp_servers
            .proxy_base_url()
            .or(self.config.general_settings.public_base_url.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    }

    pub fn resolved_mcp_proxy_base_url(&self) -> Option<String> {
        self.mcp_proxy_base_url_override()
            .or_else(|| self.configured_mcp_proxy_base_url())
    }
}

fn callbacks(config: &GatewayConfig, db: Option<PgPool>) -> CallbackManager {
    let Some(pool) = db else {
        return CallbackManager::default();
    };
    if config.general_settings.disable_spend_logs {
        return CallbackManager::default();
    }
    CallbackManager::new(vec![Arc::new(LiteLLMDBCallback::new(
        pool,
        &config.general_settings,
    ))])
}
