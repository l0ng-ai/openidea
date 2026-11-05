//! tsconfig/jsconfig path aliases for the project semantic index (see
//! `docs/vue-ts-semantic-index.md`): the configs of `from`'s ancestor
//! directories, merged nearest-first. Vite scaffolds keep their `paths` in
//! `tsconfig.app.json` while the root `tsconfig.json` only holds
//! `references` — so every `tsconfig*.json` / `jsconfig*.json` of a
//! directory is read, and `extends` chains are followed (including
//! `@tsconfig/*` packages, depth-limited).

use ide_core::jsonc;
use ide_core::paths::AliasMap;
use std::path::{Path, PathBuf};

/// The configs of one directory: `tsconfig*.json` and `jsconfig*.json`.
fn configs_of(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let base = name.strip_suffix(".json").unwrap_or("");
            (base == "jsconfig" || base == "tsconfig" || base.starts_with("tsconfig.")) && !name.ends_with(".jsonc") // tsconfig.jsonc is not a thing TypeScript reads
        })
        .collect();
    out.sort();
    out
}

/// The merged `compilerOptions.paths` + `baseUrl` of the configs governing
/// `from`: every config of each ancestor directory up to `root`, nearest
/// directory first (its patterns win over the root's).
pub fn alias_map(root: &Path, from: &Path) -> AliasMap {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut dir = Some(from.parent().unwrap_or(from).to_path_buf());
    while let Some(d) = dir {
        dirs.push(d.clone());
        if d == root {
            break;
        }
        dir = d.parent().map(Path::to_path_buf);
    }
    let mut map = AliasMap::default();
    for d in dirs.iter().rev() {
        for config in configs_of(d) {
            merge_config(&config, &mut map, 0);
        }
    }
    map
}

/// Merges one config's `paths`/`baseUrl` (following `extends`, depth-limited)
/// into `map`. Later merges override earlier ones, which makes both rules
/// work with one map: an extending config overrides its `extends` base, and
/// a nearer directory's config overrides a farther one's (the caller merges
/// root-first).
fn merge_config(path: &Path, map: &mut AliasMap, depth: u32) {
    const MAX_EXTENDS: u32 = 5;
    if depth > MAX_EXTENDS {
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else { return };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&jsonc::strip(&text)) else { return };
    // The `extends` base first, so the extending file's own entries override it.
    if let Some(extends) = value.get("extends").and_then(|e| e.as_str()) {
        let base = resolve_extends(path.parent().unwrap_or(Path::new(".")), extends);
        merge_config(&base, map, depth + 1);
    }
    let Some(options) = value.get("compilerOptions") else { return };
    if let Some(base) = options.get("baseUrl").and_then(|b| b.as_str()) {
        // `baseUrl` is relative to the config's directory.
        if let Some(dir) = path.parent() {
            map.base_url = if base == "." { dir.to_path_buf() } else { dir.join(base) };
        }
    }
    let Some(paths) = options.get("paths").and_then(|p| p.as_object()) else { return };
    for (pattern, targets) in paths {
        let targets: Vec<String> = targets
            .as_array()
            .map(|a| a.iter().filter_map(|t| t.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        if targets.is_empty() {
            continue;
        }
        match map.paths.iter_mut().find(|(p, _)| p == pattern) {
            Some(slot) => slot.1 = targets, // override: extending / nearer wins
            None => map.paths.push((pattern.clone(), targets)),
        }
    }
}

/// An `extends` value: relative to the extending config, or a package
/// (`@tsconfig/node20`) whose `tsconfig.json` sits in node_modules.
fn resolve_extends(config_dir: &Path, extends: &str) -> PathBuf {
    if extends.starts_with('.') {
        return config_dir.join(extends);
    }
    // A package reference: `pkg` or `pkg/tsconfig.build.json`.
    let file = if extends.ends_with(".json") { extends.to_string() } else { format!("{extends}/tsconfig.json") };
    let name = file.split('/').next().unwrap_or(extends);
    config_dir.join("node_modules").join(name).join(file.trim_start_matches(&format!("{name}/")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn temp() -> PathBuf {
        tempfile::tempdir().unwrap().keep()
    }

    #[test]
    fn vite_scaffold_layout_merges_app_config() {
        // The root config only references; `paths` lives in tsconfig.app.json.
        let root = temp();
        write(&root.join("tsconfig.json"), r#"{ "references": [{ "path": "./tsconfig.app.json" }] }"#);
        write(
            &root.join("tsconfig.app.json"),
            r#"{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }"#,
        );
        write(&root.join("src/main.ts"), "");
        let map = alias_map(&root, &root.join("src/main.ts"));
        assert_eq!(map.paths, vec![("@/*".to_string(), vec!["src/*".to_string()])]);
        assert_eq!(map.base_url, root);
    }

    #[test]
    fn nearest_config_wins_and_comments_parse() {
        let root = temp();
        // JSONC comments in the root config.
        write(
            &root.join("tsconfig.json"),
            r#"{ // scaffold
                "compilerOptions": { "paths": { "@/*": ["src/*"] } } }"#,
        );
        write(&root.join("src/tsconfig.json"), r#"{ "compilerOptions": { "paths": { "@/*": ["app/*"] } } }"#);
        write(&root.join("src/app/a.ts"), "");
        let map = alias_map(&root, &root.join("src/app/a.ts"));
        assert_eq!(map.paths, vec![("@/*".to_string(), vec!["app/*".to_string()])]);
    }

    #[test]
    fn extends_chain_is_followed() {
        let root = temp();
        write(&root.join("base.json"), r#"{ "compilerOptions": { "paths": { "~/*": ["lib/*"] } } }"#);
        write(
            &root.join("tsconfig.json"),
            r#"{ "extends": "./base.json", "compilerOptions": { "paths": { "@/*": ["src/*"] } } }"#,
        );
        let map = alias_map(&root, &root.join("a.ts"));
        // Both patterns: the extended one first (its entries win).
        assert_eq!(map.paths.len(), 2);
        assert!(map.paths.iter().any(|(p, _)| p == "~/*"));
        assert!(map.paths.iter().any(|(p, _)| p == "@/*"));
    }

    #[test]
    fn no_configs_is_an_empty_map() {
        let root = temp();
        let map = alias_map(&root, &root.join("a.ts"));
        assert_eq!(map, AliasMap::default());
    }
}
