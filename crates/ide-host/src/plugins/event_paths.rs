//! Project-relative event filters, kept with runtime subscriptions across idle reclaim.
use super::{LoadedPlugin, PluginHost};
use globset::{GlobBuilder, GlobMatcher};
use ide_plugin::{EventKind, HostError, WorkbenchEvent};
use std::{
    collections::{BTreeSet, HashMap},
    path::Path,
};

#[derive(Clone, Default)]
pub(super) struct Subscriptions {
    pub kinds: HashMap<String, BTreeSet<EventKind>>,
    pub paths: HashMap<String, HashMap<String, PathFilter>>,
}

#[derive(Clone)]
pub(super) struct PathFilter {
    pub globs: Vec<String>,
    matchers: Vec<GlobMatcher>,
}

impl PathFilter {
    pub fn new(kind: &str, globs: Vec<String>) -> Result<Self, HostError> {
        if !matches!(kind, "file-opened" | "file-saved" | "files-changed") {
            return Err(HostError::Invalid(
                "subscribe-paths supports file-opened, file-saved and files-changed".into(),
            ));
        }
        if globs.len() > 64 {
            return Err(HostError::Invalid("at most 64 event path globs".into()));
        }
        let mut matchers = Vec::new();
        for input in &globs {
            let glob = input.trim_start_matches("./");
            if glob.is_empty()
                || input.len() > 1024
                || glob.starts_with('/')
                || glob.contains('\\')
                || glob.contains(':')
                || glob.chars().any(char::is_control)
                || glob.split('/').any(|c| c == "..")
            {
                return Err(HostError::Invalid(
                    "event globs must be project-relative paths, at most 1024 bytes each".into(),
                ));
            }
            matchers.push(
                GlobBuilder::new(glob)
                    .literal_separator(true)
                    .build()
                    .map_err(|e| HostError::Invalid(format!("invalid event glob: {e}")))?
                    .compile_matcher(),
            );
        }
        Ok(Self { globs, matchers })
    }

    pub fn matches(&self, root: &Path, path: &Path) -> bool {
        let path = ide_plugin::resolve_real(path);
        let root = ide_plugin::resolve_real(root);
        path.strip_prefix(&root).is_ok_and(|relative| self.matchers.iter().any(|m| m.is_match(relative)))
    }
}

impl Subscriptions {
    pub fn remove(&mut self, plugin: &str) -> bool {
        self.kinds.remove(plugin).is_some() | self.paths.remove(plugin).is_some()
    }
    /// Subscribes to every event of `kind`, dropping its path filter.
    pub fn set(&mut self, plugin: &str, kind: EventKind) -> bool {
        let removed = self.paths.get_mut(plugin).is_some_and(|filters| filters.remove(kind.name()).is_some());
        self.kinds.entry(plugin.to_owned()).or_default().insert(kind) | removed
    }
    pub fn set_paths(&mut self, plugin: &str, kind: &str, filter: PathFilter) -> bool {
        let mut changed = false;
        if let Some(kind) = EventKind::parse(kind) {
            changed = self.kinds.entry(plugin.to_owned()).or_default().insert(kind);
        }
        let previous = self.paths.entry(plugin.to_owned()).or_default().insert(kind.to_owned(), filter.clone());
        previous.is_none_or(|old| old.globs != filter.globs) | changed
    }
    pub fn unsubscribe(&mut self, plugin: &str, kind: &str) -> bool {
        let removed = self.paths.get_mut(plugin).is_some_and(|filters| filters.remove(kind).is_some());
        let off = EventKind::parse(kind)
            .is_some_and(|kind| self.kinds.get_mut(plugin).is_some_and(|kinds| kinds.remove(&kind)));
        removed | off
    }
}

impl PluginHost {
    pub(super) fn filter_path_events(
        &self,
        plugin: &LoadedPlugin,
        client: Option<&str>,
        events: &[WorkbenchEvent],
        subs: &Subscriptions,
    ) -> Vec<WorkbenchEvent> {
        let Some(filters) = subs.paths.get(plugin.id()) else { return events.to_vec() };
        let workspace = self.shared.workspace();
        events
            .iter()
            .filter_map(|event| {
                if let WorkbenchEvent::FilesChanged(batch) = event {
                    let Some(filter) = filters.get(event.kind().name()) else { return Some(event.clone()) };
                    let root = workspace.as_ref()?.project_of(client?)?;
                    if plugin.dev_root.as_deref().is_some_and(|r| r != root) {
                        return None;
                    }
                    let paths = |paths: &[String]| {
                        paths
                            .iter()
                            .filter(|path| {
                                let path = Path::new(path);
                                path.is_absolute() && filter.matches(&root, path)
                            })
                            .cloned()
                            .collect::<Vec<_>>()
                    };
                    let batch = ide_plugin::FilesChanged {
                        created: paths(&batch.created),
                        modified: paths(&batch.modified),
                        removed: paths(&batch.removed),
                    };
                    return (!(batch.created.is_empty() && batch.modified.is_empty() && batch.removed.is_empty()))
                        .then_some(WorkbenchEvent::FilesChanged(batch));
                }
                let path = match event {
                    WorkbenchEvent::FileOpened(path) | WorkbenchEvent::FileSaved(path) => Path::new(path),
                    _ => return Some(event.clone()),
                };
                let Some(filter) = filters.get(event.kind().name()) else { return Some(event.clone()) };
                if !path.is_absolute() {
                    return None;
                }
                let workspace = workspace.as_ref()?;
                let root = match client {
                    Some(client) => workspace.project_of(client),
                    None => {
                        let real = ide_plugin::resolve_real(path);
                        workspace
                            .projects()
                            .into_iter()
                            .filter(|r| real.starts_with(ide_plugin::resolve_real(r)))
                            .max_by_key(|r| r.components().count())
                    }
                }?;
                if plugin.dev_root.as_deref().is_some_and(|r| r != root) {
                    return None;
                }
                filter.matches(&root, path).then(|| event.clone())
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_validation_is_bounded_and_project_relative() {
        for invalid in ["", "/etc/*", "../*", "a/../b", "C:/a", "a\\b", "a\nb", "["] {
            assert!(PathFilter::new("file-opened", vec![invalid.into()]).is_err(), "{invalid:?}");
        }
        assert!(PathFilter::new("editor-focused", vec!["*".into()]).is_err());
        assert!(PathFilter::new("file-saved", vec!["*".into(); 65]).is_err());
        assert!(PathFilter::new("file-saved", vec!["./".repeat(513)]).is_err());
        assert!(PathFilter::new("file-saved", vec![]).is_ok());
        assert!(PathFilter::new("files-changed", vec![]).is_ok());
    }

    #[test]
    fn matchers_use_or_semantics_and_component_boundaries() {
        let root = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(root.path()).unwrap();
        let filter = PathFilter::new("file-opened", vec!["./config/*.yaml".into(), "src/**/*.rs".into()]).unwrap();
        for path in ["config/a.yaml", "src/main.rs", "src/深い/a.rs"] {
            assert!(filter.matches(&root, &root.join(path)), "{path}");
        }
        for path in ["config/nested/a.yaml", "other/a.yaml", "src/a.ts"] {
            assert!(!filter.matches(&root, &root.join(path)), "{path}");
        }
        assert!(!filter.matches(&root, &root.with_extension("other").join("config/a.yaml")));
        assert!(!PathFilter::new("file-opened", vec![]).unwrap().matches(&root, &root.join("a")));
    }

    #[test]
    fn subscriptions_replace_atomically_and_legacy_subscribe_clears_filters() {
        let mut subs = Subscriptions::default();
        subs.set_paths("plugin", "file-opened", PathFilter::new("file-opened", vec!["*.rs".into()]).unwrap());
        assert!(subs.kinds["plugin"].contains(&EventKind::FileOpened));
        subs.set_paths("plugin", "file-opened", PathFilter::new("file-opened", vec![]).unwrap());
        assert!(subs.paths["plugin"]["file-opened"].globs.is_empty());
        subs.set("plugin", EventKind::FileOpened);
        assert!(subs.paths["plugin"].is_empty());
        subs.set_paths("plugin", "file-saved", PathFilter::new("file-saved", vec!["*".into()]).unwrap());
        assert!(subs.unsubscribe("plugin", "file-saved"));
        assert!(subs.remove("plugin"));
        assert!(subs.paths.is_empty() && subs.kinds.is_empty());
    }
}
