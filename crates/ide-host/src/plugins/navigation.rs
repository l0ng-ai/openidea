//! API 1.x document indexers: background snapshots become project-scoped
//! associations. Navigation and gutter markers only read validated memory indexes.
use super::PluginHost;
use ide_core::{IdeError, IdeResult, Location, Pos, Range};
use ide_extension::{Capability, Disposable, ExtensionPoint, Package, Placement, Prepared, decode};
use ide_language::SymbolTag;
use ide_plugin::Invocation;
use serde::Deserialize;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

pub const MAX_DOCUMENT_BYTES: usize = 2 << 20;
const MAX_FILES: usize = 20_000;
const MAX_EDGES: usize = 4096;

pub struct Snapshot<'a> {
    pub path: &'a Path,
    pub version: Option<u32>,
    pub text: &'a str,
    pub symbols: &'a [SymbolTag],
    pub scope: &'a str,
}

pub use ide_plugin::indexing::*;

struct File {
    version: Option<u32>,
    scope: String,
    edges: Edges,
}
#[derive(Default)]
struct Graph {
    instance: Weak<super::LoadedPlugin>,
    files: BTreeMap<PathBuf, File>,
    definitions: HashMap<String, Vec<Location>>,
    aliases: HashMap<String, Vec<(PathBuf, String)>>,
    edges: usize,
}
impl Graph {
    fn targets(&self, key: &str) -> Vec<&Location> {
        let mut keys = vec![key.to_owned()];
        let mut seen = std::collections::HashSet::new();
        let mut targets = vec![];
        while let Some(key) = keys.pop() {
            if seen.len() >= 64 || !seen.insert(key.clone()) {
                continue;
            }
            if let Some(locations) = self.definitions.get(&key) {
                targets.extend(locations.iter().take(256usize.saturating_sub(targets.len())));
                continue;
            }
            if let Some((prefix, suffix)) = key.split_once('#')
                && let Some(aliases) = self.aliases.get(&format!("{prefix}#"))
            {
                for (_, target) in aliases.iter().take(64) {
                    keys.push(format!("{target}{suffix}"));
                }
            }
        }
        targets
    }
    fn remove(&mut self, path: &Path) {
        if let Some(file) = self.files.remove(path) {
            self.edges -= file.edges.definitions.len()
                + file.edges.references.len()
                + file.edges.aliases.len()
                + file.edges.markers.len();
            for alias in file.edges.aliases {
                if let Some(entries) = self.aliases.get_mut(&alias.prefix) {
                    entries.retain(|(p, _)| p != path);
                    if entries.is_empty() {
                        self.aliases.remove(&alias.prefix);
                    }
                }
            }
            for anchor in file.edges.definitions {
                if let Some(locations) = self.definitions.get_mut(&anchor.key) {
                    locations.retain(|l| l.path.0.as_path() != path);
                    if locations.is_empty() {
                        self.definitions.remove(&anchor.key);
                    }
                }
            }
        }
    }
    fn insert(&mut self, path: PathBuf, file: File) {
        self.remove(&path);
        self.edges += file.edges.definitions.len()
            + file.edges.references.len()
            + file.edges.aliases.len()
            + file.edges.markers.len();
        for alias in &file.edges.aliases {
            self.aliases.entry(alias.prefix.clone()).or_default().push((path.clone(), alias.target.clone()));
        }
        for anchor in &file.edges.definitions {
            self.definitions.entry(anchor.key.clone()).or_default().push(Location {
                path: path.clone().into(),
                range: anchor.range,
                uri: None,
            });
        }
        self.files.insert(path, file);
    }
}

#[derive(Default)]
pub(crate) struct NavigationIndex {
    projects: HashMap<(PathBuf, Option<String>), HashMap<String, Graph>>,
    generation: u64,
    epochs: HashMap<PathBuf, u64>,
}

fn contains(range: Range, pos: Pos) -> bool {
    (range.start.line, range.start.col) <= (pos.line, pos.col) && (pos.line, pos.col) < (range.end.line, range.end.col)
}
fn valid_range(lines: &[usize], range: Range) -> bool {
    let pos = |p: Pos| lines.get(p.line as usize).is_some_and(|&length| p.col as usize <= length);
    pos(range.start) && pos(range.end) && (range.start.line, range.start.col) < (range.end.line, range.end.col)
}

impl PluginHost {
    pub(crate) fn clear_plugin_navigation(&self, id: &str) {
        let mut index = self.navigation.lock();
        index.generation = index.generation.wrapping_add(1);
        let epoch = index.generation;
        let roots: Vec<_> = index.projects.keys().cloned().collect();
        for root in roots {
            index.epochs.insert(root.0, epoch);
        }
        for graphs in index.projects.values_mut() {
            graphs.remove(id);
        }
        drop(index);
        self.emit(None, super::PluginEvent::DocumentIndexesChanged);
    }

    /// Extensions with an active, permissioned navigation provider for this root.
    pub fn navigation_extensions(&self, root: &Path) -> Vec<String> {
        if !(self.project_policy.read())(root) {
            return vec![];
        }
        self.plugins
            .read()
            .values()
            .filter(|p| p.status().is_live() && p.dev_root.as_deref().is_none_or(|r| r == root))
            .filter_map(|p| declaration(p))
            .flat_map(|d| d.extensions)
            .collect()
    }

    /// Remove stale contributions before scheduling replacement work. `None`
    /// disposes the project, including reverse-index entries, on project close.
    pub fn invalidate_navigation(&self, root: &Path, paths: Option<&[PathBuf]>) {
        self.invalidate_navigation_scope(root, None, paths);
    }

    pub fn invalidate_client_navigation(&self, root: &Path, client: Option<&str>, paths: Option<&[PathBuf]>) {
        self.invalidate_navigation_scope(root, Some(client), paths);
    }

    fn invalidate_navigation_scope(&self, root: &Path, client: Option<Option<&str>>, paths: Option<&[PathBuf]>) {
        let matches = |key: &(PathBuf, Option<String>)| key.0 == root && client.is_none_or(|c| key.1.as_deref() == c);
        let mut index = self.navigation.lock();
        index.generation = index.generation.wrapping_add(1);
        let epoch = index.generation;
        index.epochs.insert(root.to_owned(), epoch);
        if index.epochs.len() > 64
            && let Some(oldest) = index.epochs.iter().min_by_key(|(_, v)| **v).map(|(p, _)| p.clone())
        {
            index.epochs.remove(&oldest);
        }
        match paths {
            None => {
                index.projects.retain(|key, _| !matches(key));
            }
            Some(paths) => {
                for graphs in index.projects.iter_mut().filter(|(key, _)| matches(key)).map(|(_, graphs)| graphs) {
                    for graph in graphs.values_mut() {
                        for path in paths {
                            graph.remove(path);
                        }
                    }
                }
            }
        }
    }

    /// Index one bounded snapshot. No directory traversal or parsing happens in
    /// navigation_at. Call off the UI thread, in small cancellable batches.
    pub fn index_navigation(&self, root: &Path, snapshot: Snapshot<'_>, invocation: Invocation) -> IdeResult<()> {
        let Snapshot { path, version, text, symbols, scope } = snapshot;
        if !(self.project_policy.read())(root) {
            return Err(IdeError::unavailable("project is not trusted"));
        }
        if text.len() > MAX_DOCUMENT_BYTES {
            return Err(IdeError::invalid("navigation document is too large"));
        }
        let real = ide_plugin::resolve_in_root(root, &path.to_string_lossy()).map_err(IdeError::invalid)?;
        if real != path {
            return Err(IdeError::invalid("navigation requires a canonical project path"));
        }
        let project_key = (root.to_owned(), invocation.client.clone());
        let generation = self.navigation.lock().epochs.get(root).copied();
        let extension = path.extension().and_then(|e| e.to_str()).unwrap_or_default();
        let plugins: Vec<_> = self
            .plugins
            .read()
            .values()
            .filter(|p| {
                p.status().is_live()
                    && p.dev_root.as_deref().is_none_or(|r| r == root)
                    && p.meta.lock().granted.contains(&Capability::ProjectRead)
                    && declaration(p).is_some_and(|n| n.extensions.iter().any(|e| e == extension))
            })
            .cloned()
            .collect();
        if plugins.is_empty() {
            return Ok(());
        }
        let lines: Vec<_> = text.split('\n').map(|l| l.encode_utf16().count()).collect();
        for plugin in plugins {
            let (actor, activated) = self.ensure_active(&plugin, invocation.client.as_deref())?;
            if activated {
                self.changed();
            }
            let (owned_path, owned_text) = (path.to_string_lossy().into_owned(), text.to_owned());
            let symbols = symbols
                .iter()
                .map(|s| ide_plugin::indexing::IndexSymbol {
                    name: s.name.clone(),
                    kind: serde_json::to_value(s.kind)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_owned))
                        .unwrap_or_default(),
                    container: s.container.clone(),
                    range: s.range,
                })
                .collect::<Vec<_>>();
            let ctx = invocation.clone();
            let started = std::time::Instant::now();
            let result = actor.call(None, move |rt| rt.index_document(&owned_path, &owned_text, &symbols, ctx));
            let edges = self
                .finish_provider_call(&plugin, &actor, started, result)
                .ok_or_else(|| IdeError::unavailable("document indexer did not return a result"))?;
            let output_bytes = edges
                .definitions
                .iter()
                .chain(&edges.references)
                .chain(&edges.markers)
                .map(|a| a.key.len().saturating_add(32))
                .sum::<usize>()
                .saturating_add(edges.aliases.iter().map(|a| a.prefix.len() + a.target.len()).sum::<usize>());
            if output_bytes > MAX_DOCUMENT_BYTES {
                return Err(IdeError::invalid("document index output is too large"));
            }
            if edges.aliases.len() > 256
                || edges.aliases.iter().any(|a| {
                    !a.prefix.ends_with('#')
                        || !a.target.ends_with('#')
                        || a.prefix.len() > 1024
                        || a.target.len() > 1024
                })
                || edges.definitions.len() + edges.references.len() > MAX_EDGES
                || edges
                    .definitions
                    .iter()
                    .chain(&edges.references)
                    .any(|a| a.key.is_empty() || a.key.len() > 1024 || !valid_range(&lines, a.range))
            {
                return Err(IdeError::invalid("invalid navigation anchors"));
            }
            if edges.markers.len() > MAX_EDGES
                || edges.markers.iter().any(|a| a.key.is_empty() || a.key.len() > 1024 || !valid_range(&lines, a.range))
            {
                return Err(IdeError::invalid("invalid navigation markers"));
            }
            let mut index = self.navigation.lock();
            if index.epochs.get(root).copied() != generation {
                return Err(IdeError::cancelled());
            }
            // Keep a bounded number of project graphs, including closed windows
            // whose frontend did not get an opportunity to dispose its state.
            if index.projects.len() >= 16 && !index.projects.contains_key(&project_key) {
                return Err(IdeError::unavailable("navigation project limit reached"));
            }
            let graph =
                index.projects.entry(project_key.clone()).or_default().entry(plugin.id().to_owned()).or_default();
            if !graph.instance.ptr_eq(&Arc::downgrade(&plugin)) {
                *graph = Graph { instance: Arc::downgrade(&plugin), ..Default::default() };
            }
            if graph.files.len() >= MAX_FILES && !graph.files.contains_key(path) {
                return Err(IdeError::unavailable("navigation file limit reached"));
            }
            graph.remove(path);
            if graph.edges
                + edges.definitions.len()
                + edges.references.len()
                + edges.aliases.len()
                + edges.markers.len()
                > 200_000
            {
                return Err(IdeError::unavailable("navigation association limit reached"));
            }
            graph.insert(path.to_owned(), File { version, scope: scope.to_owned(), edges });
        }
        Ok(())
    }

    /// Resolves only current live providers. Disable/reload/trap cannot retain
    /// navigable stale data, even if a background snapshot finished concurrently.
    pub fn navigation_at(
        &self,
        root: &Path,
        path: &Path,
        version: u32,
        pos: Pos,
        client: Option<&str>,
        version_of: impl Fn(&Path) -> Option<u32>,
    ) -> Option<NavigationResult> {
        if !(self.project_policy.read())(root) {
            return None;
        }
        let plugins = self.plugins.read();
        let index = self.navigation.lock();
        let graphs = index.projects.get(&(root.to_owned(), client.map(str::to_owned)))?;
        let mut result: Option<NavigationResult> = None;
        for (id, graph) in graphs {
            let Some(plugin) = plugins.get(id) else { continue };
            if !plugin.status().is_live() || !graph.instance.ptr_eq(&Arc::downgrade(plugin)) {
                continue;
            }
            let Some(file) = graph.files.get(path) else { continue };
            if file.version != Some(version) {
                continue;
            }
            for reference in &file.edges.references {
                if !contains(reference.range, pos) {
                    continue;
                }
                let targets = graph.targets(&reference.key);
                if targets.is_empty() {
                    continue;
                }
                let answer = result.get_or_insert_with(|| NavigationResult { range: reference.range, targets: vec![] });
                let local = targets.iter().any(|t| graph.files.get(&t.path.0).is_some_and(|f| f.scope == file.scope));
                for target in targets.iter().take(256) {
                    let Some(target_file) = graph.files.get(&target.path.0) else {
                        continue;
                    };
                    if local && target_file.scope != file.scope {
                        continue;
                    }
                    if version_of(&target.path).is_some_and(|v| target_file.version != Some(v)) {
                        continue;
                    }
                    if (target.path.0.as_path() != path || !contains(target.range, pos))
                        && !answer.targets.iter().any(|t| t.path == target.path && t.range == target.range)
                    {
                        answer.targets.push((*target).clone());
                    }
                }
            }
        }
        result.filter(|r| !r.targets.is_empty())
    }
    /// Gutter markers of visible files. Uses only existing graph entries; never executes WASM.
    pub fn navigation_markers(
        &self,
        root: &Path,
        paths: &[PathBuf],
        client: Option<&str>,
        version_of: impl Fn(&Path) -> Option<u32>,
    ) -> Vec<FileMarkers> {
        if !(self.project_policy.read())(root) {
            return vec![];
        }
        let plugins = self.plugins.read();
        let index = self.navigation.lock();
        let Some(graphs) = index.projects.get(&(root.to_owned(), client.map(str::to_owned))) else {
            return vec![];
        };
        let mut result = vec![];
        for path in paths {
            for (id, graph) in graphs {
                let Some(plugin) = plugins.get(id) else { continue };
                if !plugin.status().is_live() || !graph.instance.ptr_eq(&Arc::downgrade(plugin)) {
                    continue;
                }
                let Some(file) = graph.files.get(path) else { continue };
                if version_of(path).is_some_and(|v| file.version != Some(v)) {
                    continue;
                }
                let mut markers = vec![];
                for anchor in &file.edges.markers {
                    let candidates = graph.targets(&anchor.key);
                    let local =
                        candidates.iter().any(|t| graph.files.get(&t.path.0).is_some_and(|f| f.scope == file.scope));
                    let mut targets = vec![];
                    for target in candidates {
                        let Some(other) = graph.files.get(&target.path.0) else { continue };
                        if (local && other.scope != file.scope)
                            || version_of(&target.path).is_some_and(|v| other.version != Some(v))
                            || (target.path.0 == *path && target.range == anchor.range)
                        {
                            continue;
                        }
                        if !targets.iter().any(|t: &Location| t.path == target.path && t.range == target.range) {
                            targets.push(target.clone());
                        }
                    }
                    if !targets.is_empty() {
                        markers.push(NavigationResult { range: anchor.range, targets });
                    }
                }
                if !markers.is_empty() {
                    result.push(FileMarkers { path: path.clone(), version: file.version, markers });
                }
            }
        }
        result
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Decl {
    extensions: Vec<String>,
}
fn declaration(p: &super::LoadedPlugin) -> Option<Decl> {
    p.manifest()
        .declarations("documentIndexers")
        .into_iter()
        .next()
        .and_then(|d| decode("documentIndexers", d.clone()).ok())
}
pub struct IndexersPoint;
impl ExtensionPoint for IndexersPoint {
    fn id(&self) -> &'static str {
        "documentIndexers"
    }
    fn placement(&self) -> Placement {
        Placement::Workspace
    }
    fn prepare(&self, pkg: &Package, value: toml::Value) -> Result<Prepared, String> {
        let d: Decl = decode(self.id(), value)?;
        if pkg.manifest.wasm.is_none()
            || d.extensions.is_empty()
            || d.extensions.len() > 32
            || d.extensions
                .iter()
                .any(|e| e.is_empty() || e.len() > 32 || !e.bytes().all(|c| c.is_ascii_alphanumeric()))
        {
            return Err("documentIndexers requires wasm and 1-32 file extensions".into());
        }
        if pkg.manifest.declarations(self.id()).len() > 1 {
            return Err("declare one document indexer per plugin".into());
        }
        Ok(Prepared::new(d.extensions.join(", "), || Ok(Disposable::new(|| {}))).capability(Capability::ProjectRead))
    }
}
