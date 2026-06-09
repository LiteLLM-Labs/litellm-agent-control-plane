use std::{
    io::{self, IsTerminal, Write},
    process::{Command, Stdio},
};

use super::{
    credentials::{credentials_path_for, load_credentials, normalize_base_url, save_credentials},
    parser::{require_non_empty, CodexArgs},
    ui::{print_codex_setup_header, print_credential_hint, print_saved_credentials, prompt_label},
};

const CODEX_PROVIDER: &str = "litellm";
const CODEX_KEY_ENV: &str = "LITELLM_API_KEY";

pub fn run_codex_wizard(args: CodexArgs) -> Result<i32, Box<dyn std::error::Error>> {
    let config_path = credentials_path_for("codex")?;
    let saved = if args.reset {
        Default::default()
    } else {
        load_credentials(&config_path)?
    };

    let mut should_save = false;
    let url = match args.url {
        Some(url) => normalize_base_url(&url)?,
        None if !saved.url.is_empty() => saved.url.clone(),
        None => {
            print_codex_setup_header(&config_path);
            should_save = true;
            prompt_url("Enter LiteLLM URL")?
        }
    };
    let key = match args.key {
        Some(key) => require_non_empty("LiteLLM API key", key)?,
        None if !saved.key.is_empty() => saved.key.clone(),
        None => {
            if !should_save {
                print_codex_setup_header(&config_path);
            }
            should_save = true;
            prompt_required("Enter LiteLLM API key")?
        }
    };

    if should_save {
        save_credentials(&config_path, &url, &key)?;
        print_saved_credentials(&config_path);
    } else {
        print_credential_hint("Using saved LiteLLM Codex settings");
    }

    let base_url = format!("{}/v1", url.trim_end_matches('/'));
    let status = Command::new(&args.codex_bin)
        .args(provider_overrides(&base_url))
        .args(&args.codex_args)
        .env(CODEX_KEY_ENV, key)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("failed to start {}: {error}", args.codex_bin),
            )
        })?;

    Ok(status.code().unwrap_or(1))
}

// Codex reads providers from ~/.codex/config.toml; `-c` overrides inject ours at
// launch without editing the user's file. `env_key` points Codex at the API key
// we export, sent upstream as `Authorization: Bearer`.
fn provider_overrides(base_url: &str) -> Vec<String> {
    vec![
        "-c".to_owned(),
        format!("model_provider=\"{CODEX_PROVIDER}\""),
        "-c".to_owned(),
        format!("model_providers.{CODEX_PROVIDER}.name=\"LiteLLM\""),
        "-c".to_owned(),
        format!("model_providers.{CODEX_PROVIDER}.base_url=\"{base_url}\""),
        "-c".to_owned(),
        format!("model_providers.{CODEX_PROVIDER}.wire_api=\"responses\""),
        "-c".to_owned(),
        format!("model_providers.{CODEX_PROVIDER}.env_key=\"{CODEX_KEY_ENV}\""),
    ]
}

fn prompt_url(prompt: &str) -> Result<String, Box<dyn std::error::Error>> {
    let raw = prompt_required(prompt)?;
    normalize_base_url(&raw)
}

fn prompt_required(prompt: &str) -> Result<String, Box<dyn std::error::Error>> {
    print!("{}", prompt_label(prompt));
    io::stdout().flush()?;

    let mut input = String::new();
    io::stdin().read_line(&mut input)?;
    if !io::stdin().is_terminal() {
        println!();
    }
    require_non_empty(prompt, input)
}

#[cfg(test)]
mod tests {
    use super::provider_overrides;

    #[test]
    fn overrides_point_codex_at_gateway_responses_api() {
        let flags = provider_overrides("https://gateway.example.com/v1");
        let joined = flags.join(" ");
        assert!(joined.contains("model_provider=\"litellm\""));
        assert!(
            joined.contains("model_providers.litellm.base_url=\"https://gateway.example.com/v1\"")
        );
        assert!(joined.contains("model_providers.litellm.wire_api=\"responses\""));
        assert!(joined.contains("model_providers.litellm.env_key=\"LITELLM_API_KEY\""));
    }
}
