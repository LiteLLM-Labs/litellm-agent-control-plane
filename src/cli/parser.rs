use std::{env, ffi::OsString};

#[derive(Debug)]
pub struct ClaudeArgs {
    pub url: Option<String>,
    pub key: Option<String>,
    pub claude_bin: String,
    pub reset: bool,
    pub claude_args: Vec<OsString>,
}

pub fn parse_claude_args(
    raw_args: impl IntoIterator<Item = OsString>,
) -> Result<ClaudeArgs, Box<dyn std::error::Error>> {
    let mut args = ClaudeArgs {
        url: None,
        key: None,
        claude_bin: non_empty_env("CLAUDE_CODE_BIN").unwrap_or_else(|| "claude".to_owned()),
        reset: false,
        claude_args: Vec::new(),
    };

    let mut raw_args = raw_args.into_iter();
    while let Some(arg) = raw_args.next() {
        if arg == "--reset" {
            args.reset = true;
            continue;
        }

        let Some(arg_str) = arg.to_str().map(str::to_owned) else {
            args.claude_args.push(arg);
            continue;
        };

        parse_arg(&arg_str, arg, &mut raw_args, &mut args)?;
    }

    Ok(args)
}

fn parse_arg(
    arg_str: &str,
    arg: OsString,
    raw_args: &mut impl Iterator<Item = OsString>,
    args: &mut ClaudeArgs,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(value) = arg_str.strip_prefix("--url=") {
        args.url = Some(require_non_empty("--url", value.to_owned())?);
    } else if arg_str == "--url" {
        args.url = Some(next_option_value("--url", raw_args)?);
    } else if let Some(value) = arg_str.strip_prefix("--key=") {
        args.key = Some(require_non_empty("--key", value.to_owned())?);
    } else if arg_str == "--key" {
        args.key = Some(next_option_value("--key", raw_args)?);
    } else if let Some(value) = arg_str.strip_prefix("--claude-bin=") {
        args.claude_bin = require_non_empty("--claude-bin", value.to_owned())?;
    } else if arg_str == "--claude-bin" {
        args.claude_bin = next_option_value("--claude-bin", raw_args)?;
    } else {
        args.claude_args.push(arg);
    }

    Ok(())
}

#[derive(Debug)]
pub struct CodexArgs {
    pub url: Option<String>,
    pub key: Option<String>,
    pub codex_bin: String,
    pub reset: bool,
    pub codex_args: Vec<OsString>,
}

pub fn parse_codex_args(
    raw_args: impl IntoIterator<Item = OsString>,
) -> Result<CodexArgs, Box<dyn std::error::Error>> {
    let mut args = CodexArgs {
        url: None,
        key: None,
        codex_bin: non_empty_env("CODEX_BIN").unwrap_or_else(|| "codex".to_owned()),
        reset: false,
        codex_args: Vec::new(),
    };

    let mut raw_args = raw_args.into_iter();
    while let Some(arg) = raw_args.next() {
        if arg == "--reset" {
            args.reset = true;
            continue;
        }

        let Some(arg_str) = arg.to_str().map(str::to_owned) else {
            args.codex_args.push(arg);
            continue;
        };

        parse_codex_arg(&arg_str, arg, &mut raw_args, &mut args)?;
    }

    Ok(args)
}

fn parse_codex_arg(
    arg_str: &str,
    arg: OsString,
    raw_args: &mut impl Iterator<Item = OsString>,
    args: &mut CodexArgs,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(value) = arg_str.strip_prefix("--url=") {
        args.url = Some(require_non_empty("--url", value.to_owned())?);
    } else if arg_str == "--url" {
        args.url = Some(next_option_value("--url", raw_args)?);
    } else if let Some(value) = arg_str.strip_prefix("--key=") {
        args.key = Some(require_non_empty("--key", value.to_owned())?);
    } else if arg_str == "--key" {
        args.key = Some(next_option_value("--key", raw_args)?);
    } else if let Some(value) = arg_str.strip_prefix("--codex-bin=") {
        args.codex_bin = require_non_empty("--codex-bin", value.to_owned())?;
    } else if arg_str == "--codex-bin" {
        args.codex_bin = next_option_value("--codex-bin", raw_args)?;
    } else {
        args.codex_args.push(arg);
    }

    Ok(())
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .and_then(|value| (!value.trim().is_empty()).then_some(value))
}

fn next_option_value(
    option: &str,
    raw_args: &mut impl Iterator<Item = OsString>,
) -> Result<String, Box<dyn std::error::Error>> {
    let value = raw_args
        .next()
        .ok_or_else(|| format!("{option} requires a value"))?;
    let value = value
        .into_string()
        .map_err(|_| format!("{option} must be valid UTF-8"))?;
    require_non_empty(option, value)
}

pub(crate) fn require_non_empty(
    name: &str,
    value: String,
) -> Result<String, Box<dyn std::error::Error>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{name} is required").into());
    }

    Ok(trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::{parse_claude_args, parse_codex_args};

    #[test]
    fn forwards_unknown_claude_flags() {
        let args = parse_claude_args(
            ["--model", "claude-sonnet-4-5", "--help"]
                .into_iter()
                .map(OsString::from),
        )
        .unwrap();

        assert_eq!(
            args.claude_args,
            vec![
                OsString::from("--model"),
                OsString::from("claude-sonnet-4-5"),
                OsString::from("--help")
            ]
        );
    }

    #[test]
    fn parses_wrapper_flags_without_forwarding_them() {
        let args = parse_claude_args(
            [
                "--url=http://localhost:4000/v1",
                "--key",
                "sk-test",
                "--claude-bin",
                "/bin/echo",
                "--reset",
            ]
            .into_iter()
            .map(OsString::from),
        )
        .unwrap();

        assert_eq!(args.url.as_deref(), Some("http://localhost:4000/v1"));
        assert_eq!(args.key.as_deref(), Some("sk-test"));
        assert_eq!(args.claude_bin, "/bin/echo");
        assert!(args.reset);
        assert!(args.claude_args.is_empty());
    }

    #[test]
    fn parses_codex_wrapper_flags_and_forwards_the_rest() {
        let args = parse_codex_args(
            [
                "--url=http://localhost:4000",
                "--key",
                "sk-test",
                "--codex-bin",
                "/bin/echo",
                "--reset",
                "exec",
                "say hi",
            ]
            .into_iter()
            .map(OsString::from),
        )
        .unwrap();

        assert_eq!(args.url.as_deref(), Some("http://localhost:4000"));
        assert_eq!(args.key.as_deref(), Some("sk-test"));
        assert_eq!(args.codex_bin, "/bin/echo");
        assert!(args.reset);
        assert_eq!(
            args.codex_args,
            vec![OsString::from("exec"), OsString::from("say hi")]
        );
    }
}
