//! Project-scoped endpoint exports, refreshed on matching filesystem changes.
use super::{PluginEvent, PluginHost};
use ide_core::ipc_path::to_ipc;
use ide_extension::{Capability, Disposable, Package, UiContribution, UiDecl, decode};
use ide_plugin::{Endpoint, HostError, Invocation};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

pub(super) const POINT: &str = "endpoints";
pub(super) const RESULTS: &str = "endpointResults";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Decl {
    files: Vec<String>,
}

pub(super) fn declaration(pkg: &Package, value: toml::Value) -> Result<UiDecl, String> {
    let d: Decl = decode(POINT, value)?;
    pkg.manifest.needs_api("contributes.endpoints", 3)?;
    if pkg.manifest.wasm.is_none() || d.files.is_empty() || d.files.len() > 64 {
        return Err("contributes.endpoints needs code and 1–64 file globs".into());
    }
    for file in &d.files {
        if file.is_empty()
            || file.len() > 1024
            || file.starts_with('/')
            || file.contains('\\')
            || file.contains(':')
            || file.split('/').any(|p| p == "..")
        {
            return Err("endpoint file globs must be project-relative".into());
        }
        matcher(file).map_err(|e| e.to_string())?;
    }
    let key = serde_json::to_string(&d.files).map_err(|e| e.to_string())?;
    Ok(UiDecl::new(key, "HTTP endpoints", serde_json::to_value(d).map_err(|e| e.to_string())?))
}

fn matcher(glob: &str) -> Result<globset::GlobMatcher, globset::Error> {
    Ok(globset::GlobBuilder::new(glob).literal_separator(true).build()?.compile_matcher())
}

#[derive(Default)]
struct Batch {
    attempted: bool,
    contribution: Option<Disposable>,
}
#[derive(Default)]
pub(super) struct Endpoints {
    generation: u64,
    batches: BTreeMap<(String, PathBuf), Batch>,
}

impl PluginHost {
    pub(super) fn clear_plugin_endpoints(&self, plugin: &str) {
        let mut state = self.endpoints.lock();
        state.generation = state.generation.wrapping_add(1);
        let count = state.batches.len();
        state.batches.retain(|(id, _), _| id != plugin);
        if count != state.batches.len() {
            self.emit(None, PluginEvent::CommandsChanged);
        }
    }

    /// Called by the project's debounced watcher; does not execute plugin code.
    pub fn invalidate_endpoints(&self, root: &Path, paths: &[PathBuf]) {
        let declarations = self.ui.items(POINT, None);
        let mut state = self.endpoints.lock();
        let mut dirty = false;
        for ((plugin, project), batch) in &mut state.batches {
            if project != root {
                continue;
            }
            let matches = declarations.iter().filter(|d| &d.plugin_id == plugin).any(|d| {
                d.decl["files"].as_array().is_some_and(|globs| {
                    globs.iter().filter_map(|g| g.as_str()).any(|g| {
                        matcher(g)
                            .is_ok_and(|m| paths.iter().any(|p| p.strip_prefix(root).is_ok_and(|rel| m.is_match(rel))))
                    })
                })
            });
            if matches {
                batch.attempted = false;
                dirty = true;
            }
        }
        if dirty {
            state.generation = state.generation.wrapping_add(1);
        }
    }

    pub(super) fn refresh_endpoints(&self) {
        let Some(workspace) = self.shared.workspace() else { return };
        let roots = workspace.projects();
        let declarations = self.ui.items(POINT, None);
        {
            let mut state = self.endpoints.lock();
            let count = state.batches.len();
            state.batches.retain(|(id, root), _| {
                roots.contains(root) && workspace.trusted(root) && declarations.iter().any(|d| &d.plugin_id == id)
            });
            if count != state.batches.len() {
                state.generation = state.generation.wrapping_add(1);
                self.emit(None, PluginEvent::CommandsChanged);
            }
        }
        let ids: std::collections::BTreeSet<_> = declarations.iter().map(|d| d.plugin_id.clone()).collect();
        for id in ids {
            for root in &roots {
                let prepared = {
                    let _lifecycle = self.lifecycle.lock();
                    let Ok(plugin) = self.get(&id) else { continue };
                    if !workspace.trusted(root) || !self.endpoint_eligible(&plugin, root) {
                        continue;
                    }
                    let mut state = self.endpoints.lock();
                    let batch = state.batches.entry((id.clone(), root.clone())).or_default();
                    if batch.attempted {
                        continue;
                    }
                    batch.attempted = true;
                    (plugin, state.generation)
                };
                let invocation = Invocation { workspace_root: Some(root.clone()), ..Default::default() };
                let result = self
                    .code_call(&id, invocation, "endpoints", |rt, ctx| rt.endpoints(ctx, Duration::from_secs(2)))
                    .and_then(|items| {
                        validate(root, items, &*workspace).map_err(|e| ide_core::IdeError::invalid(e.to_string()))
                    });
                let _lifecycle = self.lifecycle.lock();
                let mut state = self.endpoints.lock();
                if state.generation != prepared.1 {
                    if let Some(batch) = state.batches.get_mut(&(id.clone(), root.clone())) {
                        batch.attempted = false;
                    }
                    continue;
                }
                if !self.plugins.read().get(&id).is_some_and(|p| Arc::ptr_eq(p, &prepared.0))
                    || !self.endpoint_eligible(&prepared.0, root)
                    || !workspace.projects().contains(root)
                    || !workspace.trusted(root)
                {
                    continue;
                }
                match result {
                    Ok(endpoints) => {
                        let Some(batch) = state.batches.get_mut(&(id.clone(), root.clone())) else { continue };
                        batch.contribution = None;
                        if !endpoints.is_empty() {
                            batch.contribution = Some(self.ui.insert(UiContribution {
                                plugin_id: id.clone(),
                                point: RESULTS.into(),
                                key: to_ipc(root),
                                decl: serde_json::json!({"root": to_ipc(root), "endpoints": endpoints}),
                            }));
                        }
                        self.emit(None, PluginEvent::CommandsChanged);
                    }
                    Err(e) => tracing::warn!(plugin = %id, "endpoint refresh failed: {e}"),
                }
            }
        }
    }

    fn endpoint_eligible(&self, plugin: &super::LoadedPlugin, root: &Path) -> bool {
        plugin.status().is_live() && plugin.dev_root.as_deref().is_none_or(|r| r == root) && {
            let meta = plugin.meta.lock();
            meta.pending.is_empty() && meta.granted.contains(&Capability::ProjectRead)
        }
    }
}

fn validate(
    root: &Path,
    items: Vec<Endpoint>,
    workspace: &dyn super::PluginWorkspace,
) -> Result<Vec<serde_json::Value>, HostError> {
    if items.len() > 10_000 {
        return Err(HostError::Invalid("at most 10,000 endpoints".into()));
    }
    let mut bytes = 0usize;
    let mut document_bytes = 0usize;
    let mut texts: BTreeMap<PathBuf, Vec<usize>> = BTreeMap::new();
    let mut validated = Vec::with_capacity(items.len());
    for e in items {
        bytes += e.path.len()
            + e.method.as_ref().map_or(0, String::len)
            + e.framework.len()
            + e.handler.as_ref().map_or(0, String::len)
            + e.location.path.as_os_str().len();
        if bytes > 4 << 20
            || e.path.len() > 8192
            || !e.path.starts_with('/')
            || e.path.chars().any(char::is_whitespace)
            || e.path.chars().any(char::is_control)
            || e.method.as_ref().is_some_and(|m| {
                m.is_empty() || m.len() > 32 || !m.bytes().all(|b| b.is_ascii_uppercase() || b == b'-')
            })
            || e.framework.is_empty()
            || e.framework.len() > 256
            || e.framework.chars().any(char::is_control)
            || e.handler.as_ref().is_some_and(|h| h.len() > 1024 || h.chars().any(char::is_control))
        {
            return Err(HostError::Invalid("invalid endpoint or batch larger than 4 MiB".into()));
        }
        let path = ide_plugin::resolve_in_root(root, &e.location.path.to_string_lossy()).map_err(HostError::Invalid)?;
        if !texts.contains_key(&path) {
            let text = workspace
                .buffer_text(&path)
                .map(Ok)
                .unwrap_or_else(|| ide_plugin::read_text(&path).map_err(HostError::Invalid));
            let text = text?;
            document_bytes += text.len();
            if document_bytes > 16 << 20 {
                return Err(HostError::Invalid("endpoint declaration documents exceed 16 MiB".into()));
            }
            texts.insert(
                path.clone(),
                text.split('\n').map(|line| line.trim_end_matches('\r').encode_utf16().count()).collect(),
            );
        }
        let lines = &texts[&path];
        let range = e.location.range;
        if range.start > range.end
            || [range.start, range.end]
                .iter()
                .any(|p| lines.get(p.line as usize).is_none_or(|len| p.col as usize > *len))
        {
            return Err(HostError::Invalid("endpoint location is outside its UTF-16 document range".into()));
        }
        validated.push(serde_json::json!({"method": e.method, "path": e.path,
            "framework": e.framework, "handler": e.handler,
            "location": {"path": to_ipc(&path), "range": e.location.range}}));
    }
    Ok(validated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::{Pos, Range};
    struct Workspace;
    impl super::super::PluginWorkspace for Workspace {
        fn projects(&self) -> Vec<PathBuf> {
            vec![]
        }
        fn buffer_text(&self, _: &Path) -> Option<String> {
            None
        }
        fn document(&self, _: &Path) -> Option<(u64, String)> {
            None
        }
        fn trusted(&self, _: &Path) -> bool {
            true
        }
        fn project_of(&self, _: &str) -> Option<PathBuf> {
            None
        }
        fn apply_edits(&self, _: &Path, _: u64, _: &[ide_core::TextEdit]) -> Result<u64, HostError> {
            unreachable!()
        }
        fn publish_diagnostics(&self, _: &str, _: &Path, _: Vec<ide_core::Diagnostic>) -> Result<(), HostError> {
            unreachable!()
        }
    }
    fn endpoint(path: PathBuf) -> Endpoint {
        Endpoint {
            method: Some("GET".into()),
            path: "/users/{id}".into(),
            framework: "Rails".into(),
            handler: None,
            location: ide_plugin::Location { path, range: Range::new(Pos::new(0, 2), Pos::new(0, 3)) },
        }
    }
    #[test]
    fn validates_entire_rooted_batch_with_utf16_positions() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let file = root.join("routes.rb");
        std::fs::write(&file, "😀x\n").unwrap();
        let good = endpoint(file.clone());
        let items = validate(&root, vec![good.clone()], &Workspace).unwrap();
        assert_eq!(items[0]["location"]["range"]["end"]["col"], 3);
        assert!(items[0]["handler"].is_null());
        for bad in [
            Endpoint { method: Some("GET\nPOST".into()), ..good.clone() },
            Endpoint { path: "https://example.com".into(), ..good.clone() },
            Endpoint { path: "/bad\r\nPOST /".into(), ..good.clone() },
            Endpoint { handler: Some("bad\nhandler".into()), ..good.clone() },
            Endpoint {
                location: ide_plugin::Location {
                    path: file.clone(),
                    range: Range::new(Pos::new(0, 0), Pos::new(0, 4)),
                },
                ..good.clone()
            },
            Endpoint {
                location: ide_plugin::Location { path: root.join("../outside"), range: Range::default() },
                ..good.clone()
            },
        ] {
            assert!(validate(&root, vec![good.clone(), bad], &Workspace).is_err());
        }
        assert!(validate(&root, vec![good.clone(); 10_001], &Workspace).is_err());
        #[cfg(unix)]
        {
            let outside = tempfile::NamedTempFile::new().unwrap();
            std::os::unix::fs::symlink(outside.path(), root.join("escape")).unwrap();
            assert!(validate(&root, vec![endpoint(root.join("escape"))], &Workspace).is_err());
        }
    }
}
