//! The tsserver plugins a project's tsconfig.json / jsconfig.json declares
//! (`compilerOptions.plugins`, e.g. Next.js' `{ "name": "next" }`). tsserver looks for them
//! next to the TypeScript it runs from and in its plugin probe locations only, so with the
//! bundled TypeScript they are never found unless the project's folder is a probe location.
//! Language servers run in trusted projects only, so untrusted ones never load them.

use serde_json::Value;
use std::path::{Path, PathBuf};

const CONFIGS: [&str; 2] = ["tsconfig.json", "jsconfig.json"];

/// The directories of the tsconfig.json / jsconfig.json files under `server_root` that
/// declare plugins, for vtsls `typescript.tsserver.pluginPaths` (tsserver resolves a plugin
/// from `<dir>/node_modules` upwards, as `allowLocalPluginLoads` would). Logs the plugins
/// that are not installed; tsserver skips them.
pub(crate) fn probe_dirs(server_root: &Path) -> Vec<PathBuf> {
    // ponytail: bounded walk, as the path aliases'; deeper workspace members keep the old behaviour.
    const MAX_DEPTH: usize = 4;
    const MAX_ENTRIES: usize = 50_000;
    let mut walker = ignore::WalkBuilder::new(server_root);
    walker
        .max_depth(Some(MAX_DEPTH))
        .require_git(ide_core::ignored::inside_git_repo(server_root))
        .follow_links(false)
        .filter_entry(|e| e.file_name() != "node_modules");
    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in walker.build().take(MAX_ENTRIES).flatten() {
        if !CONFIGS.iter().any(|c| entry.file_name() == *c) {
            continue;
        }
        let config = entry.path();
        let Some(dir) = config.parent() else { continue };
        let names = plugins(config, 0);
        if names.is_empty() {
            continue;
        }
        for name in names.iter().filter(|n| !installed(dir, n)) {
            tracing::warn!("vtsls: tsserver plugin `{name}` from {} is not installed", config.display());
        }
        if !dirs.iter().any(|d| d == dir) {
            dirs.push(dir.to_path_buf());
        }
    }
    dirs.sort();
    dirs
}

/// `compilerOptions.plugins` names of `config`, else of the configurations it `extends`
/// (the last of an `extends` array that has some wins, as tsc merges them).
fn plugins(config: &Path, depth: usize) -> Vec<String> {
    let Some(json) = std::fs::read_to_string(config)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&ide_core::jsonc::strip(&t)).ok())
    else {
        return Vec::new();
    };
    if let Some(plugins) = json.pointer("/compilerOptions/plugins").and_then(Value::as_array) {
        return plugins.iter().filter_map(|p| p.get("name")?.as_str().map(str::to_owned)).collect();
    }
    if depth > 8 {
        return Vec::new();
    }
    let dir = config.parent().unwrap_or(Path::new(""));
    let extends = match json.get("extends") {
        Some(Value::String(s)) => vec![s.as_str()],
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    extends
        .into_iter()
        .rev()
        .filter_map(|spec| extended(dir, spec))
        .map(|base| plugins(&base, depth + 1))
        .find(|p| !p.is_empty())
        .unwrap_or_default()
}

/// The file an `extends` entry names: a path relative to `dir`, or a package's file
/// (`@tsconfig/next/tsconfig.json`, or a package's own `tsconfig.json`) in `node_modules`.
fn extended(dir: &Path, spec: &str) -> Option<PathBuf> {
    let candidates = |base: PathBuf| [base.clone(), base.with_extension("json"), base.join("tsconfig.json")];
    if spec.starts_with('.') || Path::new(spec).is_absolute() {
        return candidates(dir.join(spec)).into_iter().find(|p| p.is_file());
    }
    dir.ancestors().flat_map(|d| candidates(d.join("node_modules").join(spec))).find(|p| p.is_file())
}

/// Whether `name` resolves from `dir` the way tsserver resolves a plugin: `node_modules/<name>`
/// in `dir` or one of its ancestors.
fn installed(dir: &Path, name: &str) -> bool {
    dir.ancestors().any(|d| d.join("node_modules").join(name).exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, file: &str, text: &str) {
        let path = root.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn folders_declaring_plugins_become_probe_locations() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "package.json", "{}");
        // A monorepo: the root tsconfig has no plugins, the Next.js app (comments, trailing commas) has.
        write(root, "tsconfig.json", r#"{ "compilerOptions": { "strict": true } }"#);
        write(
            root,
            "apps/web/tsconfig.json",
            "{\n // Next.js\n \"compilerOptions\": { \"plugins\": [{ \"name\": \"next\" },] } }",
        );
        write(root, "apps/web/node_modules/next/package.json", "{}");
        // Inherited from a shared configuration, in a relative file and in a package.
        write(root, "apps/docs/tsconfig.json", r#"{ "extends": ["../../tsconfig.json", "@acme/tsconfig/next.json"] }"#);
        write(
            root,
            "node_modules/@acme/tsconfig/next.json",
            r#"{ "compilerOptions": { "plugins": [{ "name": "next" }] } }"#,
        );
        write(root, "apps/api/jsconfig.json", r#"{ "extends": "./base" }"#);
        write(root, "apps/api/base.json", r#"{ "compilerOptions": { "plugins": [{ "name": "missing-plugin" }] } }"#);
        // An empty list overrides the inherited one; node_modules is never searched for configurations.
        write(
            root,
            "apps/plain/tsconfig.json",
            r#"{ "extends": "../api/base.json", "compilerOptions": { "plugins": [] } }"#,
        );
        write(root, "node_modules/x/tsconfig.json", r#"{ "compilerOptions": { "plugins": [{ "name": "x" }] } }"#);

        assert_eq!(probe_dirs(root), ["apps/api", "apps/docs", "apps/web"].map(|d| root.join(d)));
        assert!(installed(&root.join("apps/docs"), "@acme/tsconfig"));
        assert!(!installed(&root.join("apps/api"), "missing-plugin"));
    }

    #[test]
    fn projects_without_plugins_get_no_probe_locations() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "tsconfig.json", r#"{ "extends": "./missing.json", "compilerOptions": {} }"#);
        assert!(probe_dirs(tmp.path()).is_empty());
    }
}
