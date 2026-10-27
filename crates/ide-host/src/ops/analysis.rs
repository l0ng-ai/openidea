//! Code analysis over a scope of files: Inspect Code (batch LSP diagnostics),
//! Locate Duplicates and Search / Replace Structurally (`ide-analysis`).
//!
//! Scopes are Find in Files scopes; excluded roots are never analysed. Every
//! command takes a UI-allocated `RequestId` and is cancelled via `cancel_request`.
use crate::Host;
use crate::Project;
use crate::ops::Channel;
use crate::rpc::Dispatcher;

use super::doc::blocking;
use ide_analysis::{
    DuplicateOptions, DuplicatesReport, SourceFile, StructuralFile, StructuralQuery, StructuralSummary,
};
use ide_core::{CancellationToken, Diagnostic, DocId, IdeResult, IpcPath, LanguageId, RequestId};
use ide_language::LanguageRegistry;
use ide_lsp::{FileInspection, InspectHost, InspectOptions};
use ide_search::{FileMask, SearchScope};
use ide_workspace::Documents;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

/// Files of `scope`, minus excluded roots and ignored names.
fn files_in_scope(project: &Project, scope: &SearchScope, cancel: &CancellationToken) -> IdeResult<Vec<SourceFile>> {
    let mask = FileMask::new(&[], &project.search_excludes())?;
    Ok(ide_search::scope_files(&project.root, scope, &mask, None, cancel)?
        .into_iter()
        .map(|f| SourceFile { path: f.path, rel_path: f.rel_path })
        .collect())
}

/// Current text of a file (the unsaved buffer when open) and its language.
fn load(project: &Project, languages: &LanguageRegistry, path: &Path) -> Option<(LanguageId, String)> {
    if let Some(doc) = project.documents.by_path(path) {
        let snap = project.documents.text_snapshot(doc).ok()?;
        return (!snap.large).then_some((snap.language, snap.text));
    }
    let loaded = ide_vfs::load_text(path).ok()?;
    if loaded.binary || loaded.large || loaded.too_large {
        return None;
    }
    let language = languages.detect(path, loaded.text.lines().next());
    Some((language, loaded.text))
}

// ---- Inspect Code ----

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InspectedFile {
    pub path: IpcPath,
    pub rel_path: String,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InspectSummary {
    /// Files inspected by a language server.
    pub files: u32,
    pub problems: u32,
    /// Files in scope no language server serves.
    pub skipped: u32,
    /// Files whose server failed or never became ready.
    pub failed: u32,
    pub cancelled: bool,
    pub elapsed_ms: u32,
}

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InspectEvent {
    /// Files about to be inspected.
    Started {
        total: u32,
    },
    /// A file finished (with or without problems).
    File {
        file: InspectedFile,
        done: u32,
    },
    Done {
        summary: InspectSummary,
    },
}

struct DocumentsHost(Arc<Documents>);

impl InspectHost for DocumentsHost {
    fn open(&self, path: &Path) -> IdeResult<(DocId, bool)> {
        let was_open = self.0.by_path(path).is_some();
        Ok((self.0.open(path)?.id, was_open))
    }

    fn close(&self, doc: DocId) {
        self.0.close(doc);
    }
}

// ---- Locate Duplicates ----

// ---- Structural Search ----

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StructuralEvent {
    File { file: StructuralFile },
    Done { summary: StructuralSummary },
}

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StructuralLanguage {
    pub id: LanguageId,
    pub name: String,
}

/// Inspect Code: diagnostics of every file in `scope` that a language server
/// serves. Files stream through `on_event` as they finish; ends with `Done`.
pub async fn inspect_code(
    host: &Host,
    window: &str,
    request: RequestId,
    scope: SearchScope,
    on_event: Channel<InspectEvent>,
) -> IdeResult<()> {
    let started = Instant::now();
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let listed = {
        let (project, cancel) = (project.clone(), cancel.clone());
        blocking(move || files_in_scope(&project, &scope, &cancel)).await
    };
    let files = match listed {
        Ok(files) => files,
        Err(e) => {
            host.end_request(request);
            return Err(e);
        }
    };
    let total_in_scope = files.len() as u32;
    let rel: std::collections::HashMap<_, _> = files
        .iter()
        .filter(|f| project.lsp.serves_path(&f.path))
        .map(|f| (f.path.clone(), f.rel_path.clone()))
        .collect();
    let mut summary = InspectSummary { skipped: total_in_scope - rel.len() as u32, ..Default::default() };
    let _ = on_event.send(InspectEvent::Started { total: rel.len() as u32 });

    let mut paths: Vec<_> = rel.keys().cloned().collect();
    paths.sort();
    let tally = Mutex::new(summary.clone());
    let done = std::sync::atomic::AtomicU32::new(0);
    let docs = Arc::new(DocumentsHost(project.documents.clone()));
    project
        .lsp
        .inspect_files(docs, paths, InspectOptions::default(), cancel.clone(), &|path, outcome| {
            let done = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            let diagnostics = {
                let mut t = tally.lock();
                match outcome {
                    FileInspection::Inspected(items) => {
                        t.files += 1;
                        t.problems += items.len() as u32;
                        items
                    }
                    FileInspection::NoServer => {
                        t.skipped += 1;
                        Vec::new()
                    }
                    FileInspection::Failed(message) => {
                        tracing::debug!("inspect {}: {message}", path.display());
                        t.failed += 1;
                        Vec::new()
                    }
                }
            };
            let rel_path = rel.get(&path).cloned().unwrap_or_default();
            let file = InspectedFile { path: IpcPath(path), rel_path, diagnostics };
            let _ = on_event.send(InspectEvent::File { file, done });
        })
        .await;
    host.end_request(request);
    summary = tally.into_inner();
    summary.cancelled = cancel.is_cancelled();
    summary.elapsed_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
    let _ = on_event.send(InspectEvent::Done { summary });
    Ok(())
}

/// Locate Duplicates over the files of `scope`.
pub async fn analysis_locate_duplicates(
    host: &Host,
    window: &str,
    request: RequestId,
    scope: SearchScope,
    options: DuplicateOptions,
) -> IdeResult<DuplicatesReport> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let languages = project.languages.clone();
    let syntax = host.syntax();
    let result = blocking(move || {
        let files = files_in_scope(&project, &scope, &cancel)?;
        let loader = |p: &Path| load(&project, &languages, p);
        Ok(ide_analysis::find_duplicates(&syntax, &files, &loader, &options, &cancel))
    })
    .await;
    host.end_request(request);
    result
}

/// Languages Search Structurally supports (those with a bundled grammar).
pub async fn structural_languages(host: &Host, _window: &str) -> IdeResult<Vec<StructuralLanguage>> {
    let syntax = host.syntax();
    let mut out: Vec<StructuralLanguage> = host
        .languages
        .all()
        .into_iter()
        .filter(|c| syntax.supports(&c.id))
        .map(|c| StructuralLanguage { id: c.id, name: c.name })
        .collect();
    out.sort_by_key(|l| l.name.to_lowercase());
    Ok(out)
}

/// Checks a structural search template (and language) while the user types.
pub async fn structural_validate(host: &Host, _window: &str, query: StructuralQuery) -> IdeResult<()> {
    let syntax = host.syntax();
    blocking(move || ide_analysis::validate_structural(&syntax, &query)).await
}

/// Search Structurally over `scope`; files with matches stream through
/// `on_event`, ending with `Done`. With a replacement, matches carry their
/// replacement text (applied by the UI as a workspace edit).
pub async fn structural_search(
    host: &Host,
    window: &str,
    request: RequestId,
    scope: SearchScope,
    query: StructuralQuery,
    on_event: Channel<StructuralEvent>,
) -> IdeResult<()> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let languages = project.languages.clone();
    let syntax = host.syntax();
    let events = on_event.clone();
    let result = blocking(move || {
        let files = files_in_scope(&project, &scope, &cancel)?;
        let loader = |p: &Path| load(&project, &languages, p);
        ide_analysis::search_structurally(&syntax, &files, &loader, &query, &cancel, &|file| {
            let _ = events.send(StructuralEvent::File { file });
        })
    })
    .await;
    host.end_request(request);
    let _ = on_event.send(StructuralEvent::Done { summary: result? });
    Ok(())
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("inspect_code", |c| async move {
        inspect_code(&c.host, &c.window, c.arg("request")?, c.arg("scope")?, c.sender("onEvent")?).await
    });
    d.add("analysis_locate_duplicates", |c| async move {
        analysis_locate_duplicates(&c.host, &c.window, c.arg("request")?, c.arg("scope")?, c.arg("options")?).await
    });
    d.add("structural_languages", |c| async move { structural_languages(&c.host, &c.window).await });
    d.add("structural_validate", |c| async move { structural_validate(&c.host, &c.window, c.arg("query")?).await });
    d.add("structural_search", |c| async move {
        structural_search(&c.host, &c.window, c.arg("request")?, c.arg("scope")?, c.arg("query")?, c.sender("onEvent")?)
            .await
    });
}
