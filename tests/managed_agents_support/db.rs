use sqlx::PgPool;

pub async fn reset_tables(pool: &PgPool) {
    sqlx::query(
        r#"
        TRUNCATE
          "LiteLLM_ManagedAgentSlackOAuthStatesTable",
          "LiteLLM_SlackPendingInstallsTable",
          "LiteLLM_SlackAgentBindingsTable",
          "LiteLLM_ManagedAgentSlackEventsTable",
          "LiteLLM_CredentialsTable",
          "LiteLLM_ManagedAgentSlackThreadSessionsTable",
          "LiteLLM_ManagedAgentInboxItemsTable",
          "LiteLLM_ManagedAgentRoutinesTable",
          "LiteLLM_ManagedAgentRunsTable",
          "LiteLLM_ManagedAgentFilesTable",
          "LiteLLM_ManagedAgentMemoriesTable",
          "LiteLLM_ManagedAgentsTable",
          "LiteLLM_ManagedAgentSessionsTable",
          "LiteLLM_ManagedAgentSkillsTable",
          "LiteLLM_GatewaySettingsTable",
          "LiteLLM_SavedAgentsTable"
        CASCADE
        "#,
    )
    .execute(pool)
    .await
    .unwrap();
}
