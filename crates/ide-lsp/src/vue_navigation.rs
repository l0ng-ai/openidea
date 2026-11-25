//! Vue 2 (Options API) template navigation: without `strictFunctionTypes`, the Vue 2.7
//! types infer `methods` / `computed` on `this` as `any`, so `textDocument/definition`
//! and hover in templates resolve to nothing (vuejs/language-tools#5257). The bundled
//! server can serve Vue 2.7 fine once the option is on (see #1164).

use crate::{LspManager, Server};
use ide_core::IdeEvent;
use std::path::Path;

pub(crate) const SERVER: &str = "vue-language-server";

pub(crate) const MESSAGE: &str = "Vue 2 (Options API) template navigation needs 'strictFunctionTypes': true (or 'strict': true) in the compilerOptions of jsconfig.json / tsconfig.json — without it the Vue 2.7 types infer methods and computed on this as any, so jump-to-definition and hover in templates resolve to nothing. Add the option (create jsconfig.json if the project has none), then reopen the file or restart the language server.";

impl LspManager {
    pub(crate) async fn check_vue_navigation(&self, server: &Server) {
        if server.name != SERVER || self.shown_messages.lock().contains(&(SERVER.into(), MESSAGE.into())) {
            return;
        }
        let Some(file) = self
            .docs
            .lock()
            .values()
            .find(|doc| {
                doc.language.as_str() == "vue" && doc.servers.iter().any(|attached| attached.server.id == server.id)
            })
            .map(|doc| doc.path.clone())
        else {
            return;
        };
        let root = self.project_root_for(&file);
        let Some(me) = self.me.upgrade() else { return };
        let _ = tokio::task::spawn_blocking(move || {
            if vue2_project(&root)
                && missing_strict_function_types(&root)
                && !me.shutting_down.load(std::sync::atomic::Ordering::Acquire)
                && me.first_message(SERVER, MESSAGE)
            {
                me.sink.emit(IdeEvent::LanguageServerWarning {
                    name: SERVER.into(),
                    message: MESSAGE.into(),
                    // No managed tool fixes this (the server itself is fine), so none is
                    // offered: the UI falls back to the settings shortcut only.
                    install_tool: String::new(),
                });
            }
        })
        .await;
    }
}

/// The project's `package.json` depends on Vue 2 (2.7 is the version the Vue Language
/// Tools serve; older 2.x ranges resolve to it).
fn vue2_project(root: &Path) -> bool {
    let Ok(manifest) = std::fs::read_to_string(root.join("package.json")) else { return false };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&manifest) else { return false };
    ["dependencies", "devDependencies"]
        .iter()
        .any(|section| json.get(section).and_then(|s| s.get("vue")).and_then(|v| v.as_str()).is_some_and(is_vue_2))
}

/// A `vue` version range whose major version is 2: `^2.7.16`, `~2.7`, `2.x`, `2`, `v2`.
fn is_vue_2(spec: &str) -> bool {
    let rest = spec.trim().trim_start_matches(|c: char| !(c.is_ascii_digit() || c == 'v'));
    let rest = rest.trim_start_matches('v');
    let mut parts = rest.split('.');
    parts.next().and_then(|major| major.parse::<u32>().ok()) == Some(2)
}

/// `jsconfig.json` / `tsconfig.json` at the root all lack the option: `strict` or
/// `strictFunctionTypes` is not `true` in their own `compilerOptions`. A config that
/// `extends` a base (which could set it) or can't be parsed stays quiet: a wrong hint
/// is worse than a missed one.
fn missing_strict_function_types(root: &Path) -> bool {
    ["jsconfig.json", "tsconfig.json"].iter().all(|name| match std::fs::read_to_string(root.join(name)) {
        // No config there: nothing contradicts the hint (the option defaults to off).
        Err(_) => true,
        Ok(src) => strict_function_types(&src) == Some(false),
    })
}

/// `strictFunctionTypes: true` or `strict: true` in `compilerOptions` of a JSONC config;
/// `None` when the config `extends` another or can't be parsed (the effective options
/// are unknown).
fn strict_function_types(src: &str) -> Option<bool> {
    let json = serde_json::from_str::<serde_json::Value>(&ide_core::jsonc::strip(src)).ok()?;
    if json.get("extends").and_then(|e| e.as_str()).is_some_and(|e| !e.trim().is_empty()) {
        return None;
    }
    Some(
        ["strictFunctionTypes", "strict"]
            .iter()
            .any(|key| json.get("compilerOptions").and_then(|o| o.get(key)).and_then(|v| v.as_bool()) == Some(true)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vue_2_version_ranges() {
        for spec in ["^2.7.16", "~2.7.0", "2.7", "2.x", "2.*", "2", "v2.7.16", ">=2.6.0 <3"] {
            assert!(is_vue_2(spec), "{spec}");
        }
        for spec in ["^3.5.13", "3", "~3.0.0", "latest", "workspace:*", "*"] {
            assert!(!is_vue_2(spec), "{spec}");
        }
    }

    #[test]
    fn vue_2_dependency_in_either_section() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join("package.json"),
            r#"{"dependencies": {"vue": "^2.7.16", "vue-template-compiler": "^2.7.16"}}"#,
        )
        .unwrap();
        assert!(vue2_project(root));
        std::fs::write(root.join("package.json"), r#"{"devDependencies": {"vue": "~2.7"}}"#).unwrap();
        assert!(vue2_project(root));
        std::fs::write(root.join("package.json"), r#"{"dependencies": {"vue": "^3.5.13"}}"#).unwrap();
        assert!(!vue2_project(root));
        std::fs::write(root.join("package.json"), r#"{"dependencies": {}}"#).unwrap();
        assert!(!vue2_project(root));
    }

    #[test]
    fn strict_function_types_in_jsonc() {
        // Comments and trailing commas survive a real jsconfig.json.
        let src = r#"{
            // Generated by @vue/cli.
            "compilerOptions": {
                "target": "ES6",
                "module": "commonjs", /* kept */
                "allowJs": true,
            },
            "include": ["src/**/*"],
        }"#;
        assert_eq!(strict_function_types(src), Some(false));
        assert_eq!(
            strict_function_types(&src.replace("\"allowJs\": true", "\"strictFunctionTypes\": true")),
            Some(true)
        );
        assert_eq!(strict_function_types(&src.replace("\"allowJs\": true", "\"strict\": true")), Some(true));
        assert_eq!(strict_function_types(&src.replace("\"allowJs\": true", "\"strict\": false")), Some(false));
        assert_eq!(
            strict_function_types(&src.replace(
                "\"include\": [\"src/**/*\"],",
                "\"extends\": \"@vue/tsconfig\", \"include\": [\"src/**/*\"],"
            )),
            None
        );
        assert_eq!(strict_function_types("no json here"), None);
    }

    #[test]
    fn missing_option_needs_a_quiet_config() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // No config at all: the option defaults to off.
        assert!(missing_strict_function_types(root));
        let jsconfig = root.join("jsconfig.json");
        std::fs::write(&jsconfig, r#"{"compilerOptions": {"module": "commonjs"}}"#).unwrap();
        assert!(missing_strict_function_types(root));
        // The option on in either config: navigation works there.
        std::fs::write(&jsconfig, r#"{"compilerOptions": {"strictFunctionTypes": true}}"#).unwrap();
        assert!(!missing_strict_function_types(root));
        std::fs::write(&jsconfig, r#"{"compilerOptions": {"strict": true}}"#).unwrap();
        assert!(!missing_strict_function_types(root));
        // A base config could set it: stay quiet.
        std::fs::write(&jsconfig, r#"{"extends": "./tsconfig.base.json", "compilerOptions": {}}"#).unwrap();
        assert!(!missing_strict_function_types(root));
        // An unparsable config: stay quiet.
        std::fs::write(&jsconfig, "not json").unwrap();
        assert!(!missing_strict_function_types(root));
        // tsconfig.json carries the option for a jsconfig-less project.
        std::fs::remove_file(&jsconfig).unwrap();
        std::fs::write(root.join("tsconfig.json"), r#"{"compilerOptions": {"strict": true}}"#).unwrap();
        assert!(!missing_strict_function_types(root));
    }
}
