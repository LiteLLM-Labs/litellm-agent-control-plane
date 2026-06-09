use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

#[test]
fn sdk_tree_matches_provider_endpoint_contract() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let sdk = root.join("src/sdk");
    let providers = sdk.join("providers");

    assert!(sdk.join("routing.rs").is_file());
    assert!(!sdk.join("routing").exists());
    assert!(!sdk.join("transformations").exists());

    assert_eq!(dirs(&sdk), set(["agents", "providers"]));
    assert_eq!(
        dirs(&providers),
        set([
            "anthropic",
            "base",
            "cursor",
            "gemini",
            "openai",
            "opencode"
        ])
    );
    assert_eq!(
        files(&providers.join("base")),
        set([
            "anthropic_messages.rs",
            "mod.rs",
            "openai_responses.rs",
            "runtime.rs",
        ])
    );

    assert_provider(&providers, "anthropic", ["anthropic_messages", "runtime"]);
    assert_provider(&providers, "openai", ["openai_responses"]);
    assert_provider(&providers, "cursor", ["runtime"]);
    assert_provider(&providers, "gemini", ["runtime"]);
    assert_provider(&providers, "opencode", ["runtime"]);

    let providers_mod = fs::read_to_string(providers.join("mod.rs")).unwrap();
    assert!(!providers_mod.contains("AgentRuntime::"));
    assert!(!providers_mod.contains("match runtime"));
    assert!(!providers_mod.contains("match AgentRuntime"));

    for path in rust_files(&root.join("src")) {
        let content = fs::read_to_string(&path).unwrap();
        assert!(
            !content.contains("sdk::transformations") && !content.contains("transformations::"),
            "{} still references the removed top-level transformations module",
            path.display()
        );
    }

    assert!(
        !root.join("src/managed_agents/providers").exists(),
        "src/managed_agents/providers/ must not exist — runtime provisioning belongs in sdk/providers/<provider>/runtime/"
    );
}

fn assert_provider<const N: usize>(providers: &Path, provider: &str, expected_modules: [&str; N]) {
    let provider_dir = providers.join(provider);
    assert_eq!(dirs(&provider_dir), set(expected_modules));
    assert!(provider_dir.join("mod.rs").is_file());

    for module in expected_modules {
        let module_dir = provider_dir.join(module);
        assert!(module_dir.join("mod.rs").is_file());
        if module != "runtime" {
            assert!(module_dir.join("transformation.rs").is_file());
        }
    }
}

fn dirs(path: &Path) -> BTreeSet<String> {
    entries(path, |path| path.is_dir())
}

fn files(path: &Path) -> BTreeSet<String> {
    entries(path, |path| path.is_file())
}

fn entries(path: &Path, keep: impl Fn(&Path) -> bool) -> BTreeSet<String> {
    fs::read_dir(path)
        .unwrap()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            keep(&path).then(|| entry.file_name().to_string_lossy().into_owned())
        })
        .collect()
}

fn set<const N: usize>(values: [&str; N]) -> BTreeSet<String> {
    values.into_iter().map(str::to_owned).collect()
}

fn rust_files(path: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_rust_files(path, &mut files);
    files
}

fn collect_rust_files(path: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(path).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rust_files(&path, files);
        } else if path.extension().and_then(|value| value.to_str()) == Some("rs") {
            files.push(path);
        }
    }
}
