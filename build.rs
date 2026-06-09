//! Wires in provider folders from src/sdk/providers/<name>/, so a new provider
//! needs zero edits outside its own folder.

use std::{fs, path::Path};

fn main() {
    let out_dir = std::env::var("OUT_DIR").unwrap();
    let dest = Path::new(&out_dir).join("providers_generated.rs");
    let providers = provider_modules(Path::new("src/sdk/providers"));
    fs::write(&dest, generated_source(&providers)).unwrap();
    println!("cargo:rerun-if-changed=src/sdk/providers");
}

fn provider_modules(providers_dir: &Path) -> Vec<ProviderModule> {
    let mut providers: Vec<ProviderModule> = fs::read_dir(providers_dir)
        .expect("src/sdk/providers not found")
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.is_dir() && path.join("mod.rs").exists() {
                Some(ProviderModule {
                    name: path.file_name()?.to_str()?.to_owned(),
                    endpoint_module: provider_endpoint_module(&path),
                    has_runtime: path.join("runtime").join("mod.rs").exists(),
                })
            } else {
                None
            }
        })
        .filter(|provider| provider.name != "base")
        .collect();
    providers.sort_by(|a, b| a.name.cmp(&b.name));
    providers
}

fn generated_source(providers: &[ProviderModule]) -> String {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let mods: String = providers
        .iter()
        .map(|provider| {
            let name = &provider.name;
            format!("#[path = \"{manifest}/src/sdk/providers/{name}/mod.rs\"]\npub mod {name};\n")
        })
        .collect();
    let inits: String = providers
        .iter()
        .filter_map(|provider| {
            provider
                .endpoint_module
                .as_ref()
                .map(|module| format!("    {}::{module}::init(registry);\n", provider.name))
        })
        .collect();
    let runtime_inits: String = providers
        .iter()
        .filter(|provider| provider.has_runtime)
        .map(|provider| {
            format!(
                "    {}::register_runtime_adapters(registry);\n",
                provider.name
            )
        })
        .collect();
    format!(
        "{mods}\npub fn register_all(registry: &mut crate::sdk::providers::base::ProviderRegistry) {{\n{inits}}}\n\npub(crate) fn register_runtime_adapters(registry: &mut crate::sdk::providers::base::runtime::RuntimeAdapterRegistry) {{\n{runtime_inits}}}\n"
    )
}

struct ProviderModule {
    name: String,
    endpoint_module: Option<String>,
    has_runtime: bool,
}

fn provider_endpoint_module(path: &Path) -> Option<String> {
    fs::read_dir(path)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.is_dir() && path.join("mod.rs").exists() {
                path.file_name()?.to_str().map(str::to_owned)
            } else {
                None
            }
        })
        .find(|name| name != "runtime")
}
