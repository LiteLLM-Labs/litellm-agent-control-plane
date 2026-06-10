use std::{env, path::PathBuf};

use axum::extract::Path;
use axum::response::Redirect;
use tower_http::services::{ServeDir, ServeFile};

pub fn static_files() -> ServeDir<ServeFile> {
    let dir = ui_dir();
    ServeDir::new(&dir)
        .append_index_html_on_directories(true)
        .fallback(ServeFile::new(dir.join("index.html")))
}

pub async fn redirect_to_sessions() -> Redirect {
    Redirect::temporary("/sessions/")
}

pub async fn redirect_to_inbox_item(Path(item_id): Path<String>) -> Redirect {
    Redirect::temporary(&format!("/inbox/?item={}", encode_query_value(&item_id)))
}

fn ui_dir() -> PathBuf {
    env::var_os("LITELLM_UI_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("src/ui/out"))
}

fn encode_query_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
