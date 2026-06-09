use std::{
    fs,
    path::{Path, PathBuf},
};

use reqwest::Url;

use super::{
    parser::require_non_empty,
    ui::{print_credential_hint, BLUE, GREEN, RESET},
};

#[derive(Debug, Default)]
pub(crate) struct SavedCredentials {
    pub url: String,
    pub key: String,
}

pub(crate) fn credentials_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    credentials_path_for("claude")
}

pub(crate) fn credentials_path_for(tool: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let home = std::env::var("HOME").map_err(|_| "HOME is required to store LiteLLM settings")?;
    Ok(PathBuf::from(home)
        .join(".config")
        .join("lite")
        .join(format!("{tool}.env")))
}

pub(crate) fn load_credentials(
    path: &Path,
) -> Result<SavedCredentials, Box<dyn std::error::Error>> {
    if !path.exists() {
        return Ok(SavedCredentials::default());
    }

    let raw = fs::read_to_string(path)?;
    parse_credentials(&raw)
}

pub(crate) fn save_credentials(
    path: &Path,
    url: &str,
    key: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let body = format!("litellm_url={url}\nlitellm_api_key={key}\n");
    fs::write(path, body)?;
    restrict_file_permissions(path)?;
    Ok(())
}

pub fn logout() -> Result<(), Box<dyn std::error::Error>> {
    let mut removed_any = false;
    for tool in ["claude", "codex"] {
        let path = credentials_path_for(tool)?;
        if path.exists() {
            fs::remove_file(&path)?;
            println!(
                "{GREEN}Removed{RESET} LiteLLM {tool} settings from {}",
                path.display()
            );
            removed_any = true;
        }
    }
    if !removed_any {
        println!("{BLUE}No saved LiteLLM settings{RESET}");
    }
    print_credential_hint(
        "Enter new credentials with `lite claude --reset` or `lite codex --reset`",
    );
    Ok(())
}

pub(crate) fn normalize_base_url(raw: &str) -> Result<String, Box<dyn std::error::Error>> {
    let trimmed = raw.trim().trim_end_matches('/');
    let mut url = Url::parse(trimmed)?;
    match url.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("LiteLLM URL must use http or https, got {scheme}").into()),
    }

    if url.path() == "/v1" {
        url.set_path("");
    }

    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn parse_credentials(raw: &str) -> Result<SavedCredentials, Box<dyn std::error::Error>> {
    let mut credentials = SavedCredentials::default();
    for line in raw.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "litellm_url" => credentials.url = normalize_base_url(value)?,
            "litellm_api_key" => {
                credentials.key = require_non_empty("LiteLLM API key", value.to_owned())?
            }
            _ => {}
        }
    }
    Ok(credentials)
}

#[cfg(unix)]
fn restrict_file_permissions(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_file_permissions(_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::NamedTempFile;

    use super::{load_credentials, normalize_base_url, save_credentials};

    #[test]
    fn trims_trailing_slash() {
        assert_eq!(
            normalize_base_url("https://gateway.example.com/").unwrap(),
            "https://gateway.example.com"
        );
    }

    #[test]
    fn strips_v1_suffix_for_anthropic_base_url() {
        assert_eq!(
            normalize_base_url("https://gateway.example.com/v1").unwrap(),
            "https://gateway.example.com"
        );
    }

    #[test]
    fn rejects_non_http_urls() {
        let error = normalize_base_url("file:///tmp/socket").unwrap_err();
        assert!(error.to_string().contains("http or https"));
    }

    #[test]
    fn saves_and_loads_credentials() {
        let file = NamedTempFile::new().unwrap();
        save_credentials(file.path(), "https://gateway.example.com", "sk-test").unwrap();

        let credentials = load_credentials(file.path()).unwrap();
        assert_eq!(credentials.url, "https://gateway.example.com");
        assert_eq!(credentials.key, "sk-test");
    }

    #[test]
    #[cfg(unix)]
    fn saved_credentials_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let file = NamedTempFile::new().unwrap();
        save_credentials(file.path(), "https://gateway.example.com", "sk-test").unwrap();

        let mode = fs::metadata(file.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn missing_credentials_load_as_empty() {
        let file = NamedTempFile::new().unwrap();
        let path = file.path().to_owned();
        drop(file);

        let credentials = load_credentials(&path).unwrap();
        assert!(credentials.url.is_empty());
        assert!(credentials.key.is_empty());
    }
}
