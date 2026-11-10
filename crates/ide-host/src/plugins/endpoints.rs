//! `[[contributes.endpoints]]`: HTTP routes a plugin finds in a project. The UI
//! asks for them (`plugin_endpoints`); the host caches each plugin's list per
//! project until a file matching its globs changes, then emits `EndpointsChanged`.
use super::{PluginEvent, PluginHost};
use ide_core::{IdeResult, ipc_path::to_ipc};
use ide_extension::{Capability, Package, UiDecl, decode};
use ide_plugin::{Endpoint, HostError, Invocation};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

pub(super) const POINT: &str = "endpoints";

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

/// A route as the UI gets it.
#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginEndpoint {
    /// `None` accepts any method.
    pub method: Option<String>,
    /// Path parameters in braces: `/photos/{id}`.
    pub path: String,
    pub framework: String,
    /// Display name, e.g. `PhotosController#show`.
    pub handler: Option<String>,
    /// Where the route is declared.
    pub location: ide_core::Location,
}

#[derive(Default)]
pub(super) struct Endpoints {
    /// Bumped by every invalidation: a list computed across one is kept but not trusted.
    epoch: u64,
    cache: BTreeMap<(String, PathBuf), Cached>,
}

struct Cached {
    list: Arc<Vec<PluginEndpoint>>,
    fresh: bool,
}

impl PluginHost {
    /// `plugin`'s routes in the project `root`: the cached list while no file
    /// matching its globs changed, else computed again. Runs plugin code, so
    /// call it on a blocking thread. A failed or invalid run keeps the last list.
    pub fn endpoints(&self, plugin: &str, root: &Path) -> IdeResult<Arc<Vec<PluginEndpoint>>> {
        let Some(workspace) = self.shared.workspace() else { return Ok(Arc::default()) };
        let open = |root: &Path| workspace.projects().iter().any(|r| r == root) && workspace.trusted(root);
        let loaded = self.get(plugin)?;
        let key = (plugin.to_owned(), root.to_path_buf());
        let epoch = {
            let mut state = self.endpoints.lock();
            state.cache.retain(|(_, r), _| open(r));
            if !open(root) || !self.endpoint_eligible(&loaded, root) {
                return Ok(Arc::default());
            }
            if let Some(cached) = state.cache.get(&key).filter(|c| c.fresh) {
                return Ok(cached.list.clone());
            }
            state.epoch
        };
        let invocation = Invocation { workspace_root: Some(root.to_path_buf()), ..Default::default() };
        let result = self
            .code_call(plugin, invocation, "endpoints", |rt, ctx| rt.endpoints(ctx, Duration::from_secs(2)))
            .and_then(|items| {
                validate(root, items, &*workspace).map_err(|e| ide_core::IdeError::invalid(e.to_string()))
            });
        let mut state = self.endpoints.lock();
        // Disabled, replaced or closed meanwhile: its routes are gone.
        let current = self.plugins.read().get(plugin).is_some_and(|p| Arc::ptr_eq(p, &loaded));
        if !current || !open(root) || !self.endpoint_eligible(&loaded, root) {
            state.cache.remove(&key);
            return Ok(Arc::default());
        }
        let fresh = state.epoch == epoch;
        let list = match result {
            Ok(list) => Arc::new(list),
            Err(e) => {
                tracing::warn!(plugin, "endpoints failed: {e}");
                state.cache.get(&key).map(|c| c.list.clone()).unwrap_or_default()
            }
        };
        state.cache.insert(key, Cached { list: list.clone(), fresh });
        Ok(list)
    }

    pub(super) fn clear_plugin_endpoints(&self, plugin: &str) {
        let mut state = self.endpoints.lock();
        state.epoch += 1;
        let roots: Vec<PathBuf> = state.cache.keys().filter(|(id, _)| id == plugin).map(|(_, r)| r.clone()).collect();
        state.cache.retain(|(id, _), _| id != plugin);
        drop(state);
        for root in roots {
            self.emit(None, PluginEvent::EndpointsChanged { plugin_id: plugin.to_owned(), root: to_ipc(&root).into() });
        }
    }

    /// Called by the project's file watcher; doesn't run plugin code.
    pub fn invalidate_endpoints(&self, root: &Path, paths: &[PathBuf]) {
        let rel: Vec<&Path> = paths.iter().filter_map(|p| p.strip_prefix(root).ok()).collect();
        if rel.is_empty() {
            return;
        }
        let declarations = self.ui.items(POINT, None);
        let mut state = self.endpoints.lock();
        state.epoch += 1;
        let mut changed = Vec::new();
        for ((plugin, project), cached) in &mut state.cache {
            let matches = project == root
                && declarations.iter().filter(|d| &d.plugin_id == plugin).any(|d| {
                    d.decl["files"].as_array().is_some_and(|globs| {
                        globs
                            .iter()
                            .filter_map(|g| matcher(g.as_str()?).ok())
                            .any(|m| rel.iter().any(|p| m.is_match(p)))
                    })
                });
            if matches && cached.fresh {
                cached.fresh = false;
                changed.push(plugin.clone());
            }
        }
        drop(state);
        for plugin_id in changed {
            self.emit(None, PluginEvent::EndpointsChanged { plugin_id, root: to_ipc(root).into() });
        }
    }

    fn endpoint_eligible(&self, plugin: &super::LoadedPlugin, root: &Path) -> bool {
        plugin.status().is_live()
            && plugin.dev_root.as_deref().is_none_or(|r| r == root)
            && !self.ui.items(POINT, Some(plugin.id())).is_empty()
            && {
                let meta = plugin.meta.lock();
                meta.pending.is_empty() && meta.granted.contains(&Capability::ProjectRead)
            }
    }
}

fn validate(
    root: &Path,
    items: Vec<Endpoint>,
    workspace: &dyn super::PluginWorkspace,
) -> Result<Vec<PluginEndpoint>, HostError> {
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
        validated.push(PluginEndpoint {
            method: e.method,
            path: e.path,
            framework: e.framework,
            handler: e.handler,
            location: ide_core::Location { path: to_ipc(&path).into(), range, uri: None },
        });
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
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let file = root.join("routes.rb");
        std::fs::write(&file, "😀x\n").unwrap();
        let good = endpoint(file.clone());
        let items = validate(&root, vec![good.clone()], &Workspace).unwrap();
        assert_eq!(items[0].location.range.end.col, 3);
        assert!(items[0].handler.is_none());
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
