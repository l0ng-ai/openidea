//! The tsserver plugins a project's tsconfig.json / jsconfig.json declares
//! (`compilerOptions.plugins`, e.g. Next.js' `{ "name": "next" }`). tsserver looks for them
//! next to the TypeScript it runs from and in its plugin probe locations only, so with the
//! bundled TypeScript they are never found unless the project's folder is a probe location.
//! Language servers run in trusted projects only, so untrusted ones never load them.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const CONFIGS: [&str; 2] = ["tsconfig.json", "jsconfig.json"];

/// The packages of the plugins that the tsconfig.json / jsconfig.json files under `server_root`
/// declare, by plugin name, resolved as tsserver resolves a plugin from a probe location:
/// `node_modules` in the configuration's folder or above. Logs the declared plugins that are
/// not installed; tsserver skips them.
pub(crate) fn declared(server_root: &Path) -> BTreeMap<String, PathBuf> {
    // ponytail: bounded walk, as the path aliases'; deeper workspace members keep the old behaviour.
    const MAX_DEPTH: usize = 4;
    const MAX_ENTRIES: usize = 50_000;
    let mut walker = ignore::WalkBuilder::new(server_root);
    walker
        .max_depth(Some(MAX_DEPTH))
        .require_git(ide_core::ignored::inside_git_repo(server_root))
        .follow_links(false)
        .filter_entry(|e| e.file_name() != "node_modules");
    let mut configs: Vec<PathBuf> = walker
        .build()
        .take(MAX_ENTRIES)
        .flatten()
        .filter(|e| CONFIGS.iter().any(|c| e.file_name() == *c))
        .map(|e| e.into_path())
        .collect();
    configs.sort();
    // ponytail: one package per name; a monorepo with two versions of a plugin gets the first one's.
    let mut packages = BTreeMap::new();
    for config in configs {
        let Some(dir) = config.parent() else { continue };
        for name in plugins(&config, 0).into_iter().filter(|n| package_name(n)) {
            match dir.ancestors().map(|d| d.join("node_modules").join(&name)).find(|p| p.is_dir()) {
                Some(package) => {
                    packages.entry(name).or_insert(package);
                }
                None => tracing::warn!("vtsls: tsserver plugin `{name}` from {} is not installed", config.display()),
            }
        }
    }
    packages
}

/// A plugin probe location under `data_dir` holding a package for each of `plugins` that
/// loads the project's one, and nothing else: packages the project has under the names of the
/// IDE's global plugins never shadow those, as the project folder itself would (vtsls puts
/// `pluginPaths` before the global plugins' locations). Named after its contents, so a change
/// is a new location (and a configuration change that restarts vtsls). `None` without plugins
/// or when it cannot be written.
pub(crate) fn probe_location(
    data_dir: &Path,
    server_root: &Path,
    plugins: &BTreeMap<String, PathBuf>,
) -> Option<PathBuf> {
    if plugins.is_empty() {
        return None;
    }
    let parent = data_dir.join("tsplugins").join("project").join(key(&server_root.to_string_lossy()));
    let location = parent.join(key(&serde_json::to_string(plugins).ok()?));
    for (name, package) in plugins {
        let dir = location.join("node_modules").join(name);
        std::fs::create_dir_all(&dir).ok()?;
        let index = format!("module.exports = require({});\n", Value::from(package.to_string_lossy()));
        let manifest = serde_json::json!({ "name": name, "main": "index.js" }).to_string();
        for (file, content) in [("index.js", index), ("package.json", manifest)] {
            if std::fs::read(dir.join(file)).ok().as_deref() != Some(content.as_bytes()) {
                std::fs::write(dir.join(file), content).ok()?;
            }
        }
    }
    // The previous contents: a running tsserver loaded its plugins already.
    for old in std::fs::read_dir(&parent).into_iter().flatten().flatten() {
        if old.path() != location {
            let _ = std::fs::remove_dir_all(old.path());
        }
    }
    Some(location)
}

fn key(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// An npm package name (`next`, `@scope/name`): it becomes a path under the data dir.
fn package_name(name: &str) -> bool {
    let parts: Vec<&str> = name.split('/').collect();
    let part = |p: &str| {
        !p.is_empty() && p != "." && p != ".." && p.chars().all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c))
    };
    match parts.as_slice() {
        [name] => part(name),
        [scope, name] => scope.strip_prefix('@').is_some_and(part) && part(name),
        _ => false,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, file: &str, text: &str) {
        let path = root.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn declared_plugins_resolve_to_the_project_packages() {
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
        // Inherited from a shared configuration, in a package and in a relative file; resolved upwards.
        write(root, "apps/docs/tsconfig.json", r#"{ "extends": ["../../tsconfig.json", "@acme/tsconfig/next.json"] }"#);
        write(
            root,
            "node_modules/@acme/tsconfig/next.json",
            r#"{ "compilerOptions": { "plugins": [{ "name": "@acme/plugin" }] } }"#,
        );
        write(root, "node_modules/@acme/plugin/package.json", "{}");
        write(root, "apps/api/jsconfig.json", r#"{ "extends": "./base" }"#);
        write(
            root,
            "apps/api/base.json",
            r#"{ "compilerOptions": { "plugins": [{ "name": "missing-plugin" }, { "name": "../../escape" }] } }"#,
        );
        // An empty list overrides the inherited one; node_modules is never searched for configurations.
        write(
            root,
            "apps/plain/tsconfig.json",
            r#"{ "extends": "../api/base.json", "compilerOptions": { "plugins": [] } }"#,
        );
        write(root, "node_modules/x/tsconfig.json", r#"{ "compilerOptions": { "plugins": [{ "name": "x" }] } }"#);

        let declared = declared(root);
        let expected = [("@acme/plugin", "node_modules/@acme/plugin"), ("next", "apps/web/node_modules/next")];
        assert_eq!(declared, expected.map(|(n, p)| (n.to_owned(), root.join(p))).into_iter().collect());

        // Forwarding packages, replaced when the plugins change.
        let data = tempfile::tempdir().unwrap();
        let location = probe_location(data.path(), root, &declared).unwrap();
        let index = std::fs::read_to_string(location.join("node_modules/@acme/plugin/index.js")).unwrap();
        assert!(index.contains(&serde_json::to_string(&root.join("node_modules/@acme/plugin")).unwrap()), "{index}");
        let next_only: BTreeMap<_, _> = declared.into_iter().filter(|(n, _)| n == "next").collect();
        let changed = probe_location(data.path(), root, &next_only).unwrap();
        assert_ne!(changed, location);
        assert!(!location.exists() && changed.join("node_modules/next/index.js").is_file());
        assert_eq!(probe_location(data.path(), root, &BTreeMap::new()), None);
    }

    #[test]
    fn plugin_names_are_package_names() {
        for ok in ["next", "@scope/name", "gql.tada", "@styled/typescript-styled-plugin"] {
            assert!(package_name(ok), "{ok}");
        }
        for bad in ["", "..", "../x", "a/b", "@scope", "@/x", "@scope/..", "a\\b", "/abs"] {
            assert!(!package_name(bad), "{bad}");
        }
    }

    #[test]
    fn projects_without_plugins_declare_none() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "tsconfig.json", r#"{ "extends": "./missing.json", "compilerOptions": {} }"#);
        assert!(declared(tmp.path()).is_empty());
    }
}
