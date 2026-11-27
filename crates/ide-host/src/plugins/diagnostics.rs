//! Versioned, project-scoped diagnostics for unsaved editor buffers.
use super::{PluginHost, ProviderKind, editor_plugin_host};
use ide_core::{CancellationToken, Diagnostic, DocId, IdeEvent, SharedSink};
use ide_plugin::ProviderDocument;
use ide_text::AppliedChange;
use ide_workspace::documents::DocumentObserver;
use ide_workspace::{DocumentInfo, Documents};
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Weak};
use std::time::Duration;

const DEBOUNCE: Duration = Duration::from_millis(300);

struct Document {
    snapshot: ProviderDocument,
    cancel: CancellationToken,
    sources: HashSet<String>,
}

#[derive(Default)]
pub(super) struct State {
    closed: bool,
    documents: HashMap<DocId, Document>,
    generations: HashMap<String, u64>,
}

/// One incarnation of one project's documents, shared by all its editors.
pub(crate) struct Diagnostics {
    state: Arc<Mutex<State>>,
    sink: SharedSink,
    runtime: tokio::runtime::Handle,
    documents: Weak<Documents>,
    root: std::path::PathBuf,
}

impl Diagnostics {
    pub fn new(
        sink: SharedSink,
        runtime: tokio::runtime::Handle,
        documents: &Arc<Documents>,
        root: &Path,
    ) -> Arc<Self> {
        Arc::new(Self {
            state: Arc::default(),
            sink,
            runtime,
            documents: Arc::downgrade(documents),
            root: root.to_path_buf(),
        })
    }

    fn emit(&self, path: &Path, plugin: &str, items: Vec<Diagnostic>) {
        self.sink.emit(IdeEvent::Diagnostics {
            path: path.to_path_buf().into(),
            source: format!("plugin-provider:{plugin}"),
            items,
        });
    }

    fn clear_document(&self, doc: &Document) {
        doc.cancel.cancel();
        for plugin in &doc.sources {
            self.emit(&doc.snapshot.path, plugin, Vec::new());
        }
    }

    pub fn close(&self) {
        let mut state = self.state.lock();
        state.closed = true;
        for (_, doc) in state.documents.drain() {
            self.clear_document(&doc);
        }
    }

    fn schedule(&self, id: DocId, state: &mut State) {
        let Some(doc) = state.documents.get_mut(&id) else { return };
        doc.cancel.cancel();
        doc.cancel = CancellationToken::new();
        let Some(host) = editor_plugin_host() else { return };
        if host.providers.plugins_for(ProviderKind::Diagnostics, &doc.snapshot.language).is_empty()
            && !host.providers.any(ProviderKind::Injections)
        {
            return;
        }
        // Register only once per project incarnation; no project is retained by the host.
        let weak = Arc::downgrade(&self.state);
        {
            let mut projects = host.diagnostic_projects.lock();
            projects.retain(|(state, _)| state.strong_count() > 0);
            if !projects.iter().any(|(state, _)| state.ptr_eq(&weak)) {
                projects.push((weak.clone(), self.sink.clone()));
            }
        }
        let root = self.root.clone();
        let (mut snapshot, cancel, sink, documents) =
            (doc.snapshot.clone(), doc.cancel.clone(), self.sink.clone(), self.documents.clone());
        let lifecycle_generations = state.generations.clone();
        self.runtime.spawn(async move {
            tokio::time::sleep(DEBOUNCE).await;
            if cancel.is_cancelled() || weak.strong_count() == 0 {
                return;
            }
            let _ = tokio::task::spawn_blocking(move || {
                let Some(documents) = documents.upgrade() else { return };
                let Ok(current) = documents.snapshot(id) else { return };
                if u64::from(current.version) != snapshot.version
                    || current.path.0 != snapshot.path
                    || current.language.as_str() != snapshot.language
                    || cancel.is_cancelled()
                {
                    return;
                }
                snapshot.text = current.text;
                drop(documents);

                let injections = host.providers.injection_generations(&snapshot.language);
                let generations = host.providers.diagnostic_generations(&snapshot.language);
                let results = if snapshot.text.len() <= super::navigation::MAX_DOCUMENT_BYTES {
                    host.provide_project_diagnostics(Some(&root), &snapshot, &cancel)
                } else {
                    Vec::new()
                };
                let Some(state) = weak.upgrade() else { return };
                let mut state = state.lock();
                if state.closed || cancel.is_cancelled() {
                    return;
                }
                if injections != host.providers.injection_generations(&snapshot.language)
                    || injections.keys().any(|id| lifecycle_generations.get(id) != state.generations.get(id))
                {
                    return;
                }
                let matching: HashSet<_> = host
                    .diagnostic_plugins(Some(&root), &snapshot.language)
                    .into_iter()
                    .map(|p| p.id().to_owned())
                    .filter(|p| lifecycle_generations.get(p) == state.generations.get(p))
                    .collect();
                let latest = host.providers.diagnostic_generations(&snapshot.language);
                let Some(doc) = state.documents.get_mut(&id) else { return };
                if doc.snapshot.version != snapshot.version || doc.snapshot.path != snapshot.path {
                    return;
                }
                let mut current = HashSet::new();
                for (plugin, items) in results {
                    if !matching.contains(&plugin)
                        || !generations.get(&plugin).is_some_and(|seq| latest.get(&plugin) == Some(seq))
                    {
                        continue;
                    }
                    current.insert(plugin.clone());
                    sink.emit(IdeEvent::Diagnostics {
                        path: snapshot.path.clone().into(),
                        source: format!("plugin-provider:{plugin}"),
                        items,
                    });
                }
                for plugin in doc.sources.difference(&current) {
                    sink.emit(IdeEvent::Diagnostics {
                        path: snapshot.path.clone().into(),
                        source: format!("plugin-provider:{plugin}"),
                        items: Vec::new(),
                    });
                }
                doc.sources = current;
            })
            .await;
        });
    }
}

impl DocumentObserver for Diagnostics {
    fn opened(&self, info: &DocumentInfo) {
        let mut state = self.state.lock();
        if state.closed {
            return;
        }
        if let Some(old) = state.documents.remove(&info.id) {
            self.clear_document(&old);
        }
        if info.large || info.uri.is_some() {
            return;
        }
        state.documents.insert(
            info.id,
            Document {
                snapshot: ProviderDocument {
                    path: info.path.0.clone(),
                    language: info.language.to_string(),
                    version: u64::from(info.version),
                    text: String::new(),
                },
                cancel: CancellationToken::new(),
                sources: HashSet::new(),
            },
        );
        self.schedule(info.id, &mut state);
    }

    fn changed(&self, id: DocId, path: &Path, version: u32, _: &[AppliedChange], _text: &dyn Fn() -> String) {
        let mut state = self.state.lock();
        if state.closed {
            return;
        }
        let Some(doc) = state.documents.get_mut(&id) else { return };
        if doc.snapshot.path != path {
            self.clear_document(doc);
            doc.sources.clear();
        }
        doc.snapshot.path = path.to_path_buf();
        doc.snapshot.version = u64::from(version);
        self.schedule(id, &mut state);
    }

    fn closed(&self, id: DocId, _: &Path) {
        if let Some(doc) = self.state.lock().documents.remove(&id) {
            self.clear_document(&doc);
        }
    }
}

impl Drop for Diagnostics {
    fn drop(&mut self) {
        self.close();
    }
}

pub(super) type ProjectState = (Weak<Mutex<State>>, SharedSink);

impl PluginHost {
    pub(super) fn clear_provider_diagnostics(&self, plugin: &str) {
        // Clone before taking a project's state lock (edits register in the other order).
        let injector = self.get(plugin).is_ok_and(|p| {
            p.manifest().declarations("providers").iter().any(|d| {
                d.get("kinds")
                    .and_then(|v| v.as_array())
                    .is_some_and(|v| v.iter().any(|k| k.as_str() == Some("injections")))
            })
        });
        let projects = self.diagnostic_projects.lock().clone();
        for (state, sink) in projects {
            if let Some(state) = state.upgrade() {
                let mut state = state.lock();
                // A completed answer can still be waiting for another provider.
                *state.generations.entry(plugin.to_owned()).or_default() += 1;
                for doc in state.documents.values_mut() {
                    if injector {
                        for source in doc.sources.drain() {
                            sink.emit(IdeEvent::Diagnostics {
                                path: doc.snapshot.path.clone().into(),
                                source: format!("plugin-provider:{source}"),
                                items: vec![],
                            });
                        }
                    } else if doc.sources.remove(plugin) {
                        sink.emit(IdeEvent::Diagnostics {
                            path: doc.snapshot.path.clone().into(),
                            source: format!("plugin-provider:{plugin}"),
                            items: Vec::new(),
                        });
                    }
                }
            }
        }
    }
}
