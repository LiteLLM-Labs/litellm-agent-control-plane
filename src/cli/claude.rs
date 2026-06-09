use std::{
    io::{self, IsTerminal, Write},
    path::Path,
    process::{Command, Stdio},
};

use super::{
    credentials::{credentials_path, load_credentials, normalize_base_url, save_credentials},
    parser::{require_non_empty, ClaudeArgs},
    skills::ensure_lite_schedule_skill,
    ui::{print_credential_hint, print_saved_credentials, print_setup_header, prompt_label},
};

pub fn run_claude_wizard(args: ClaudeArgs) -> Result<i32, Box<dyn std::error::Error>> {
    let config_path = credentials_path()?;
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
            print_wizard_header(&config_path);
            should_save = true;
            prompt_url("Enter LiteLLM URL")?
        }
    };
    let key = match args.key {
        Some(key) => require_non_empty("LiteLLM API key", key)?,
        None if !saved.key.is_empty() => saved.key.clone(),
        None => {
            if !should_save {
                print_wizard_header(&config_path);
            }
            should_save = true;
            prompt_required("Enter LiteLLM API key")?
        }
    };

    if should_save {
        save_credentials(&config_path, &url, &key)?;
        print_saved_credentials(&config_path);
    } else {
        print_credential_hint("Using saved LiteLLM Claude settings");
    }

    ensure_lite_schedule_skill(&std::env::current_dir()?)?;

    let status = Command::new(&args.claude_bin)
        .args(&args.claude_args)
        .env("ANTHROPIC_BASE_URL", url)
        .env("ANTHROPIC_AUTH_TOKEN", key)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("failed to start {}: {error}", args.claude_bin),
            )
        })?;

    Ok(status.code().unwrap_or(1))
}

fn print_wizard_header(config_path: &Path) {
    print_setup_header(config_path);
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
