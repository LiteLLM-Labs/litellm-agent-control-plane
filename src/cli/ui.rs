use std::{
    io::{self, Write},
    path::Path,
};

pub(crate) const BLUE: &str = "\x1b[38;5;63m";
pub(crate) const BOLD: &str = "\x1b[1m";
pub(crate) const RESET: &str = "\x1b[0m";

const CYAN: &str = "\x1b[38;5;81m";
const DIM: &str = "\x1b[2m";
pub(crate) const GREEN: &str = "\x1b[38;5;84m";
const CHANGE_KEY_HINT: &str = "lite logout  |  lite claude --reset";

pub(crate) fn print_setup_header(config_path: &Path) {
    println!();
    print_brand_header("Claude Code bridge");
    println!();
    println!("{DIM}╭─ setup wizard ────────────────────────╮{RESET}");
    println!("  {CYAN}1{RESET}  Enter your LiteLLM URL");
    println!("     {DIM}Example: http://127.0.0.1:4000{RESET}");
    println!("  {CYAN}2{RESET}  Paste your LiteLLM API key");
    println!("     {DIM}Stored locally with 0600 permissions{RESET}");
    println!("  {CYAN}3{RESET}  Start Claude Code through LiteLLM");
    println!("  {CYAN}config{RESET}  {}", config_path.display());
    println!("  {CYAN}change{RESET}  {CHANGE_KEY_HINT}");
    println!("{DIM}╰────────────────────────────────────────╯{RESET}");
    println!();
}

pub(crate) fn print_codex_setup_header(config_path: &Path) {
    println!();
    print_brand_header("Codex bridge");
    println!();
    println!("{DIM}╭─ setup wizard ────────────────────────╮{RESET}");
    println!("  {CYAN}1{RESET}  Enter your LiteLLM URL");
    println!("     {DIM}Example: http://127.0.0.1:4000{RESET}");
    println!("  {CYAN}2{RESET}  Paste your LiteLLM API key");
    println!("     {DIM}Stored locally with 0600 permissions{RESET}");
    println!("  {CYAN}3{RESET}  Start Codex through LiteLLM");
    println!("  {CYAN}config{RESET}  {}", config_path.display());
    println!("  {CYAN}change{RESET}  {CHANGE_KEY_HINT}");
    println!("{DIM}╰────────────────────────────────────────╯{RESET}");
    println!();
}

pub(crate) fn print_tool_selector() {
    println!();
    print_brand_header("AI tool launcher");
    println!();
    println!("{DIM}╭─ select tool ─────────────────────────╮{RESET}");
    println!("  {BLUE}❯{RESET} {BOLD}claude{RESET}  {DIM}Claude Code through LiteLLM{RESET}");
    println!("  {BLUE}❯{RESET} {BOLD}codex{RESET}   {DIM}Codex through LiteLLM{RESET}");
    println!("{DIM}╰────────────────────────────────────────╯{RESET}");
    println!("{DIM}Press Enter to use claude, or type codex.{RESET}");
    println!();
    print!("{}", prompt_label("AI tool [claude]"));
    let _ = io::stdout().flush();
}

pub(crate) fn print_saved_credentials(config_path: &Path) {
    println!(
        "{GREEN}Saved{RESET}     LiteLLM settings -> {}",
        config_path.display()
    );
    print_credential_hint("Next time, run the same `lite` command");
}

pub(crate) fn print_credential_hint(message: &str) {
    println!("{DIM}{message}. Change key: {CHANGE_KEY_HINT}{RESET}");
}

pub(crate) fn prompt_label(label: &str) -> String {
    format!("{BLUE}❯{RESET} {BOLD}{label}{RESET} ")
}

fn print_brand_header(subtitle: &str) {
    println!("{BLUE}{BOLD}LiteLLM{RESET} {DIM}devtools{RESET}");
    println!("{DIM}{subtitle} · Anthropic-compatible gateway{RESET}");
}
