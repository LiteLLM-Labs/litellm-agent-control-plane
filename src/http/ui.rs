use std::{env, path::PathBuf};

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

fn ui_dir() -> PathBuf {
    env::var_os("LITELLM_UI_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("src/ui/out"))
}
