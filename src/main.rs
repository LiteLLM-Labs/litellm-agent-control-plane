use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use axum::Router as AxumRouter;
use clap::{Args as ClapArgs, Parser, Subcommand};
use litellm_rust::{
    db::managed_agents::{pool as managed_agents_pool, settings as managed_agents_settings},
    http::routes::router,
    model_prices,
    proxy::{
        config::{load_config, GatewayConfig},
        state::AppState,
    },
    sdk::{
        providers::{self, ProviderRegistry},
        routing::Router,
    },
};
use tokio::net::TcpListener;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

mod cli;

#[derive(Debug, Parser)]
#[command(about = "Low-overhead LiteLLM-compatible gateway")]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,

    #[command(flatten)]
    serve: ServeArgs,
}

#[derive(Debug, Subcommand)]
enum Command {
    Serve(ServeArgs),
    Logout,
}

#[derive(Debug, Clone, ClapArgs)]
struct ServeArgs {
    #[arg(long, env = "LITELLM_CONFIG", default_value = "config.yaml")]
    config: PathBuf,

    #[arg(long, env = "HOST", default_value = "127.0.0.1")]
    host: String,

    #[arg(long, env = "PORT", default_value_t = 4000)]
    port: u16,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    match std::env::args_os().nth(1).as_deref() {
        Some(arg) if arg == std::ffi::OsStr::new("claude") => {
            let claude_args = cli::parse_claude_args(std::env::args_os().skip(2))?;
            std::process::exit(cli::run_claude_wizard(claude_args)?);
        }
        Some(arg) if arg == std::ffi::OsStr::new("codex") => {
            let codex_args = cli::parse_codex_args(std::env::args_os().skip(2))?;
            std::process::exit(cli::run_codex_wizard(codex_args)?);
        }
        None => {
            std::process::exit(cli::run_tool_selector()?);
        }
        _ => {}
    }

    let args = Args::parse();
    match args.command {
        Some(Command::Serve(serve)) => serve_gateway(serve).await,
        Some(Command::Logout) => cli::logout(),
        None => serve_gateway(args.serve).await,
    }
}

async fn serve_gateway(args: ServeArgs) -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenvy::dotenv();

    init_tracing();

    let config = load_config(&args.config)?;
    let mut providers = ProviderRegistry::new();
    providers::register_all(&mut providers);

    let model_router = Router::from_config(&config, &providers)?;
    let http = AppState::build_http_client()?;
    let model_cost_map = model_prices::load(&http).await;
    let db = build_managed_agents_pool(&config).await?;
    let state = Arc::new(AppState::new(
        config.clone(),
        model_router,
        http,
        model_cost_map,
        db,
    )?);
    load_gateway_settings(&state).await?;

    let addr: SocketAddr = format!("{}:{}", args.host, args.port).parse()?;
    let app: AxumRouter = router(state).layer(TraceLayer::new_for_http());
    let listener = TcpListener::bind(addr).await?;

    print_startup_banner(&config, addr);
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    println!("\nINFO:     Shutting down LiteLLM Proxy Server");
    Ok(())
}

fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();
}

async fn build_managed_agents_pool(
    config: &GatewayConfig,
) -> Result<Option<sqlx::PgPool>, Box<dyn std::error::Error>> {
    let Some(database_url) = config.general_settings.database_url.as_deref() else {
        return Ok(None);
    };
    let pool = managed_agents_pool::connect(database_url).await?;
    managed_agents_pool::migrate(&pool).await?;
    Ok(Some(pool))
}

async fn load_gateway_settings(state: &Arc<AppState>) -> Result<(), Box<dyn std::error::Error>> {
    let Some(pool) = state.db.as_ref() else {
        return Ok(());
    };
    let value = managed_agents_settings::repository::get_mcp_proxy_base_url(pool).await?;
    state.set_mcp_proxy_base_url_override(value);
    Ok(())
}

fn print_startup_banner(config: &GatewayConfig, addr: SocketAddr) {
    println!("\nLiteLLM: Proxy initialized with Config, Set models:");
    for entry in &config.model_list {
        println!("  {}", entry.model_name);
    }
    // Aggregation behind a bare `/mcp` is not yet supported. Warn loudly so a
    // multi-server config does not silently behave as single-server.
    if config.mcp_servers.len() > 1 {
        tracing::warn!(
            "{} MCP servers configured; aggregation behind bare /mcp is not supported — \
             clients must target /mcp/{{name}} or send x-litellm-mcp-server / ?server=",
            config.mcp_servers.len()
        );
    }
    if config.general_settings.master_key.is_some() {
        println!("LiteLLM: Set Master Key");
    }
    println!("INFO:     Application startup complete.");
    println!(
        "INFO:     Uvicorn running on http://{} (Press CTRL+C to quit)",
        addr
    );
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
