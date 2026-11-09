//! Arduino sketches need their own board context, including their C/C++ sources.

use crate::LspManager;
use crate::server::Server;
use ide_core::{LanguageId, Location};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub(crate) const SERVER: &str = "arduino-language-server";

pub(crate) fn sketch_root(project: &Path, file: &Path) -> Option<PathBuf> {
    ide_language::arduino_sketch_root(project, file)
}

pub(crate) fn configure_client_capabilities(capabilities: &mut Value) {
    // Arduino's proxy cannot decode the boolean full form, panics on inlayHint (#225),
    // and cannot handle clangd's semanticTokens refresh request (#125).
    for section in ["textDocument", "workspace"] {
        if let Some(section) = capabilities[section].as_object_mut() {
            section.remove("semanticTokens");
            section.remove("inlayHint");
        }
    }
    // ALS uses go.bug.st/lsp (LSP 3.14) which requires a `range` field on `lsp.TextEdit`.
    // Clangd returns `InsertReplaceEdit` (`insert` + `replace`) when `insertReplaceSupport` is advertised,
    // causing ALS to drop the connection with "json: undefined required field range into lsp.TextEdit".
    if let Some(completion) = capabilities.get_mut("textDocument").and_then(|t| t.get_mut("completion"))
        && let Some(item) = completion.get_mut("completionItem").and_then(|c| c.as_object_mut())
    {
        item.remove("insertReplaceSupport");
    }
}

pub(crate) fn sanitize_server_capabilities(capabilities: &mut Value) {
    // Arduino Language Server's request dispatcher advertises documentSymbol and
    // workspaceSymbol, but panics with "not implemented" / "unimplemented" when called.
    // Tree-sitter handles C++ outline/symbols in OpenIDEA without hitting ALS.
    if let Some(obj) = capabilities.as_object_mut() {
        obj.remove("documentSymbolProvider");
        obj.remove("workspaceSymbolProvider");
    }
}

impl LspManager {
    pub(crate) fn arduino_servers(&self, language: &LanguageId, path: &Path) -> Option<Vec<Arc<Server>>> {
        if !matches!(language.as_str(), "c" | "cpp") {
            return None;
        }
        let configs = self.language_servers(&LanguageId::new("arduino"));
        let cfg = configs.iter().find(|cfg| cfg.name == SERVER)?;
        let project = self.project_root_for(path);
        if sketch_root(&project, path).is_some() {
            let server = self.server_for(cfg, &LanguageId::new("arduino"), path);
            server.add_language(language);
            let mut servers = vec![server];
            servers.extend(
                self.language_servers(language)
                    .iter()
                    .filter(|cfg| cfg.name != "clangd" && cfg.name != SERVER)
                    .filter(|cfg| {
                        !cfg.require_root_marker
                            || crate::launch::marked_root(&project, path, &cfg.root_markers).is_some()
                    })
                    .map(|cfg| self.server_for(cfg, language, path)),
            );
            return Some(servers);
        }
        if !path.starts_with(&project)
            && let Some(server) = self.origin_server(&crate::uri::path_to_uri_string(path))
            && server.name == SERVER
        {
            return Some(vec![server]);
        }
        None
    }

    pub(crate) fn note_arduino_sources(&self, server: &Arc<Server>, locations: &[Location]) {
        if server.name != SERVER {
            return;
        }
        let mut origins = None;
        for location in locations {
            let path: &Path = &location.path;
            if location.uri.is_none() && !path.starts_with(self.project_root_for(path)) {
                origins
                    .get_or_insert_with(|| self.virtual_origins.lock())
                    .insert(crate::uri::path_to_uri_string(path), server.id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_server_allows_diagnostics() {
        let registry = ide_language::LanguageRegistry::load(None).unwrap();
        let language = registry.get(&LanguageId::new("arduino")).unwrap();
        let cfg = language.language_servers.iter().find(|cfg| cfg.name == SERVER).unwrap();
        assert!(crate::caps::Restriction::new(SERVER, &cfg.features, &cfg.code_action_kinds).diagnostics());
    }

    #[tokio::test]
    async fn inspection_checks_the_sketch_server_and_root_for_all_sources() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let sketch = root.join("examples/blink");
        std::fs::create_dir_all(&sketch).unwrap();
        std::fs::write(sketch.join("blink.ino"), "").unwrap();
        let registry = Arc::new(ide_language::LanguageRegistry::load(None).unwrap());
        let manager = LspManager::new(root.to_path_buf(), registry, Arc::new(|_: ide_core::IdeEvent| {}));
        let expected_root = sketch.clone();
        manager.set_config_hook(Box::new(move |cfg, server_root| {
            cfg.command = std::env::current_exe().unwrap().to_string_lossy().into_owned();
            if cfg.name != SERVER || server_root != expected_root {
                cfg.launch_error = Some("unavailable".into());
            }
        }));
        for name in ["blink.ino", "helper.cpp", "helper.h"] {
            assert!(manager.serves_path(&sketch.join(name)), "{name}");
        }
        assert!(!manager.serves_path(&root.join("main.cpp")));
    }

    #[test]
    fn nested_sketches_keep_separate_board_roots() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let inner = root.join("examples/blink");
        std::fs::create_dir_all(inner.join("src")).unwrap();
        std::fs::write(root.join("main.ino"), "").unwrap();
        std::fs::write(inner.join("blink.ino"), "").unwrap();
        assert_eq!(sketch_root(root, &inner.join("blink.ino")), Some(inner.clone()));
        assert_eq!(sketch_root(root, &inner.join("src/helper.cpp")), Some(inner));
        assert_eq!(sketch_root(root, &root.join("helper.h")), Some(root.to_path_buf()));
        assert_eq!(sketch_root(&root.join("examples"), &root.join("other.cpp")), None);
    }

    #[test]
    fn ordinary_cpp_projects_and_ino_named_directories_are_not_sketches() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("not-a-file.ino")).unwrap();
        assert_eq!(sketch_root(dir.path(), &dir.path().join("main.cpp")), None);
    }

    #[tokio::test]
    async fn cpp_routing_is_scoped_to_sketches_and_respects_disabled_arduino() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let sketch = root.join("examples/blink");
        std::fs::create_dir_all(&sketch).unwrap();
        std::fs::write(sketch.join("blink.ino"), "").unwrap();
        let registry = Arc::new(ide_language::LanguageRegistry::load(None).unwrap());
        let manager = LspManager::new(root.to_path_buf(), registry, Arc::new(|_: ide_core::IdeEvent| {}));
        let cpp = LanguageId::new("cpp");
        let sketch_servers = manager.servers_for(&cpp, &sketch.join("helper.cpp"));
        assert_eq!(sketch_servers.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), [SERVER]);
        assert_eq!(sketch_servers[0].root, sketch);
        assert!(sketch_servers[0].languages().contains(&LanguageId::new("arduino")));
        assert_eq!(manager.servers_for(&cpp, &root.join("main.cpp"))[0].name, "clangd");
        manager.set_servers_hook(Box::new(
            |language, defined| {
                if language.as_str() == "arduino" { Vec::new() } else { defined.to_vec() }
            },
        ));
        assert_eq!(manager.servers_for(&cpp, &sketch.join("helper.cpp"))[0].name, "clangd");
    }

    #[test]
    fn capabilities_are_sanitized_for_arduino_proxy_quirks() {
        let mut client = serde_json::json!({
            "textDocument": {
                "semanticTokens": { "dynamicRegistration": false },
                "inlayHint": { "dynamicRegistration": false },
                "completion": {
                    "completionItem": {
                        "snippetSupport": true,
                        "insertReplaceSupport": true
                    }
                }
            },
            "workspace": {
                "semanticTokens": { "refreshSupport": true },
                "inlayHint": { "refreshSupport": true }
            }
        });
        configure_client_capabilities(&mut client);
        assert!(client["textDocument"].get("semanticTokens").is_none());
        assert!(client["textDocument"].get("inlayHint").is_none());
        assert!(client["textDocument"]["completion"]["completionItem"].get("insertReplaceSupport").is_none());
        assert_eq!(client["textDocument"]["completion"]["completionItem"]["snippetSupport"], true);
        assert!(client["workspace"].get("semanticTokens").is_none());
        assert!(client["workspace"].get("inlayHint").is_none());

        let mut server = serde_json::json!({
            "documentSymbolProvider": {},
            "workspaceSymbolProvider": {},
            "completionProvider": { "triggerCharacters": ["."] },
            "hoverProvider": true
        });
        sanitize_server_capabilities(&mut server);
        assert!(server.get("documentSymbolProvider").is_none());
        assert!(server.get("workspaceSymbolProvider").is_none());
        assert!(server.get("completionProvider").is_some());
        assert!(server.get("hoverProvider").is_some());
    }
}
