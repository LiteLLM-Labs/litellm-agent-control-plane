use sqlx::{
    postgres::{PgConnectOptions, PgPoolOptions},
    Executor, PgPool,
};

use crate::errors::GatewayError;

const MIGRATION_LOCK_KEY: i64 = 7_420_250_601;

pub async fn connect(database_url: &str) -> Result<PgPool, GatewayError> {
    let opts = database_url
        .parse::<PgConnectOptions>()
        .map_err(GatewayError::Database)?
        .statement_cache_capacity(0);
    PgPoolOptions::new()
        .max_connections(10)
        // Flush any pgbouncer server-side plan cache on every new connection.
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                conn.execute("DISCARD ALL").await?;
                Ok(())
            })
        })
        .connect_with(opts)
        .await
        .map_err(GatewayError::Database)
}

pub async fn migrate(pool: &PgPool) -> Result<(), GatewayError> {
    let mut connection = pool.acquire().await.map_err(GatewayError::Database)?;
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(MIGRATION_LOCK_KEY)
        .execute(&mut *connection)
        .await
        .map_err(GatewayError::Database)?;
    sqlx::migrate!("src/db/managed_agents/migrations")
        .run(&mut *connection)
        .await
        .map_err(GatewayError::Migration)?;
    sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(MIGRATION_LOCK_KEY)
        .execute(&mut *connection)
        .await
        .map_err(GatewayError::Database)?;
    Ok(())
}
