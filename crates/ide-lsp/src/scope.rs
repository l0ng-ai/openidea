//! Reference searches beyond a server's analysis scope.
//!
//! Servers answer `textDocument/references` (and rename, incoming calls) from
//! the files they analyse: their configured scope (Pyright's `include`, a
//! `tsconfig.json`, a compilation database) plus the open documents. Usages in
//! other project files are silently missing. So, as a word index would, the
//! project files of the server's languages that contain the symbol's name as a
//! whole word (found through the host's [`CandidateFn`]) and that the first
//! answer did not cover are opened on the server for a second request, then
//! closed again. Diagnostics the server publishes for them are dropped.

use crate::server::{Running, Server};
use crate::text::DocText;
use crate::types::{HierarchyItem, ReferencesIncomplete};
use crate::{DocSnap, LspManager, Target};
use futures::StreamExt;
use ide_core::{CancellationToken, IdeError, IdeResult, LanguageId, Location, Pos};
use lsp_types as lsp;
use serde_json::json;
use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// Files opened for one search at most.
pub const MAX_CANDIDATES: usize = 300;
/// Larger files (generated code, bundles) are not opened.
const MAX_CANDIDATE_BYTES: u64 = 1 << 20;
/// How long a search that found nothing waits for a server to finish indexing.
const INDEX_WAIT: Duration = Duration::from_secs(10);

/// Project files that may mention a symbol.
#[derive(Clone, Debug)]
pub struct CandidateQuery {
    /// Matched as a whole word, case-sensitively.
    pub word: String,
    /// Only files under this directory (the server's workspace root).
    pub root: PathBuf,
    /// Only files of these languages.
    pub languages: Vec<LanguageId>,
    pub limit: usize,
}

#[derive(Clone, Debug, Default)]
pub struct CandidateFiles {
    pub files: Vec<PathBuf>,
    /// More files matched than `limit`.
    pub limit_hit: bool,
}

/// Finds [`CandidateFiles`] (honouring the project's ignore rules); runs on a
/// blocking thread and should stop early when cancelled.
pub type CandidateFn = dyn Fn(&CandidateQuery, &CancellationToken) -> CandidateFiles + Send + Sync;

/// What a Go search adds beyond gopls' own answer.
#[derive(Default)]
pub(crate) struct GoMentions {
    pub locations: Vec<Location>,
    /// The declarations containing them, as incoming calls (when asked for).
    pub callers: Vec<HierarchyItem>,
}

/// A reference-based answer and, when files were opened for it, the second one.
pub(crate) struct Widened<R> {
    pub first: R,
    pub second: Option<R>,
    pub incomplete: Option<ReferencesIncomplete>,
}

impl<R> Widened<R> {
    /// An answer from the server's analysis scope alone; `empty`: it found nothing.
    pub fn only(first: R, empty: bool, server: &Server) -> Self {
        let incomplete = (empty && server.is_busy()).then_some(ReferencesIncomplete::Indexing);
        Self { first, second: None, incomplete }
    }
}

/// The name a search is about: the word at `pos` (a PHP `$` sigil dropped).
fn search_word(snap: &DocSnap, pos: Pos) -> Option<String> {
    let r = snap.text.word_range_at(pos)?;
    let text = snap.text.as_str();
    let word = text.get(snap.text.byte_offset(r.start)..snap.text.byte_offset(r.end))?.trim_start_matches('$');
    (!word.is_empty() && !word.chars().all(|c| c.is_ascii_digit())).then(|| word.to_owned())
}

impl LspManager {
    /// Finds the project files a references search may open (see the module docs).
    pub fn set_candidates_hook(&self, hook: Box<CandidateFn>) {
        *self.candidates_hook.write() = Some(Arc::from(hook));
    }

    async fn candidates(&self, t: &Target, word: String, cancel: &CancellationToken) -> Option<CandidateFiles> {
        let hook = self.candidates_hook.read().clone()?;
        let query = CandidateQuery {
            word,
            root: t.server.root.clone(),
            languages: t.server.languages(),
            limit: MAX_CANDIDATES,
        };
        let cancel = cancel.clone();
        tokio::task::spawn_blocking(move || hook(&query, &cancel)).await.ok()
    }

    /// Runs `query` on `t`; then again with the project files that mention the
    /// symbol at `pos` and are not in `covered(first)` opened on the server.
    /// A first answer that is empty while the server indexes is retried once
    /// indexing ends.
    pub(crate) async fn widened<R, F, Fut>(
        &self,
        snap: &DocSnap,
        t: &Target,
        pos: Pos,
        cancel: &CancellationToken,
        query: F,
        covered: impl Fn(&R) -> Vec<PathBuf>,
    ) -> IdeResult<Widened<R>>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = IdeResult<R>>,
    {
        let busy = t.server.is_busy();
        // gopls searches the view of the file asked about; files opened for it only get views of
        // their own (see `go_scope`).
        let word = search_word(snap, pos).filter(|_| t.caps().open_close && snap.language.as_str() != "go");
        let candidates = async {
            match word {
                Some(w) => self.candidates(t, w, cancel).await,
                None => None,
            }
        };
        let (first, candidates) = futures::join!(query(), candidates);
        let mut first = first?;
        if busy && covered(&first).is_empty() && t.server.wait_idle(INDEX_WAIT, cancel).await {
            first = query().await?;
        }
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        // Servers report analysis progress often; only "nothing found" while it lasts is suspect.
        let mut incomplete =
            (t.server.is_busy() && covered(&first).is_empty()).then_some(ReferencesIncomplete::Indexing);
        let Some(candidates) = candidates else { return Ok(Widened { first, second: None, incomplete }) };
        if candidates.limit_hit {
            incomplete = incomplete.or(Some(ReferencesIncomplete::TooManyFiles));
        }
        let known: HashSet<PathBuf> = covered(&first).into_iter().chain([snap.path.clone()]).collect();
        let files: Vec<PathBuf> = candidates.files.into_iter().filter(|f| !known.contains(f)).collect();
        if files.is_empty() {
            return Ok(Widened { first, second: None, incomplete });
        }
        let opened = self.open_transient(t, files, cancel).await;
        if opened.skipped {
            incomplete = incomplete.or(Some(ReferencesIncomplete::FilesSkipped));
        }
        if opened.files.is_empty() {
            return Ok(Widened { first, second: None, incomplete });
        }
        tracing::debug!("{}: opened {} more files for a references search", t.server.name, opened.files.len());
        let second = query().await;
        drop(opened);
        match second {
            Ok(second) => {
                if !covered(&second).is_empty() && incomplete == Some(ReferencesIncomplete::Indexing) {
                    incomplete = None;
                }
                Ok(Widened { first, second: Some(second), incomplete })
            }
            Err(e) if cancel.is_cancelled() => Err(e),
            Err(e) => {
                tracing::debug!("{}: widened references search: {}", t.server.name, e.message);
                Ok(Widened { first, second: None, incomplete })
            }
        }
    }

    /// Go: usages of the symbol at `pos` that the search at `pos` does not reach (see
    /// `go_scope`), each mention of the name resolved in its own file's view; with `callers`,
    /// also the declarations containing them, as incoming calls.
    pub(crate) async fn go_mentions_beyond_search(
        &self,
        snap: &DocSnap,
        t: &Target,
        pos: Pos,
        cancel: &CancellationToken,
        callers: bool,
    ) -> GoMentions {
        if snap.language.as_str() != "go" || !t.caps().open_close {
            return GoMentions::default();
        }
        let Some(word) = search_word(snap, pos) else { return GoMentions::default() };
        let declarations: Vec<Location> = self
            .goto_in(snap, std::slice::from_ref(t), "textDocument/definition", pos, Some(cancel), None)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|l| l.uri.is_none())
            .collect();
        let Some(declaration) = declarations.first() else { return GoMentions::default() };
        let Some(candidates) = self.candidates(t, word.clone(), cancel).await else { return GoMentions::default() };
        let (origin, declared) = (snap.path.clone(), declaration.path.to_path_buf());
        let files = tokio::task::spawn_blocking(move || {
            crate::go_scope::files_beyond_search(&origin, &declared, candidates.files)
                .into_iter()
                .filter_map(|f| {
                    let text = std::fs::read_to_string(&f).ok()?;
                    let ranges = crate::go_scope::word_ranges(&text, &word);
                    (!ranges.is_empty()).then(|| (f, DocText::new(&text), ranges))
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        if files.is_empty() || cancel.is_cancelled() {
            return GoMentions::default();
        }
        // Open, each file gives gopls a view to resolve its mentions in (its module, its build).
        let _opened = self.open_transient(t, files.iter().map(|(f, _, _)| f.clone()).collect(), cancel).await;
        let texts: Vec<(PathBuf, Arc<DocText>)> =
            files.iter().map(|(path, text, _)| (path.clone(), Arc::new(text.clone()))).collect();
        let probes: Vec<(PathBuf, Arc<DocText>, ide_core::Range)> = files
            .into_iter()
            .zip(&texts)
            .flat_map(|((path, _, ranges), (_, text))| {
                let text = text.clone();
                ranges.into_iter().map(move |r| (path.clone(), text.clone(), r))
            })
            .collect();
        let declarations = &declarations;
        let found: Vec<Option<Location>> = futures::stream::iter(probes)
            .map(|(path, text, range)| async move {
                let params = json!({
                    "textDocument": { "uri": crate::uri::path_to_uri_string(&path) },
                    "position": text.ide_to_lsp(t.enc(), range.start),
                });
                let r = crate::loading::while_loading(
                    &t.server,
                    Some(cancel),
                    crate::loading::LOADING_WAIT,
                    crate::goto_is_empty,
                    || {
                        self.call::<_, Option<lsp::GotoDefinitionResponse>>(
                            t,
                            "textDocument/definition",
                            params.clone(),
                            Some(cancel),
                            crate::DEFAULT_TIMEOUT,
                        )
                    },
                )
                .await;
                let targets = match r {
                    Ok(Some(r)) => crate::convert::goto_response(&self.conv(t.enc()), r),
                    _ => return None,
                };
                let same = targets
                    .iter()
                    .any(|l| declarations.iter().any(|d| d.path == l.path && d.range.start == l.range.start));
                same.then(|| Location { path: path.into(), range, uri: None })
            })
            .buffer_unordered(8)
            .collect()
            .await;
        let locations: Vec<Location> = found.into_iter().flatten().collect();
        let mut out = GoMentions { callers: Vec::new(), locations };
        if callers && !cancel.is_cancelled() {
            for (path, text) in &texts {
                let here: Vec<ide_core::Range> =
                    out.locations.iter().filter(|l| l.path == *path).map(|l| l.range).collect();
                if !here.is_empty() {
                    out.callers.extend(self.go_callers_in(t, path, text, &here, cancel).await);
                }
            }
        }
        if cancel.is_cancelled() {
            return GoMentions::default();
        }
        out
    }

    /// The declarations of `path` containing `calls`, innermost first, each with its call sites.
    async fn go_callers_in(
        &self,
        t: &Target,
        path: &Path,
        text: &DocText,
        calls: &[ide_core::Range],
        cancel: &CancellationToken,
    ) -> Vec<HierarchyItem> {
        let params = json!({ "textDocument": { "uri": crate::uri::path_to_uri_string(path) } });
        let r: IdeResult<Option<lsp::DocumentSymbolResponse>> =
            self.call(t, "textDocument/documentSymbol", params, Some(cancel), crate::DEFAULT_TIMEOUT).await;
        let range =
            |r: lsp::Range| ide_core::Range::new(text.lsp_to_ide(t.enc(), r.start), text.lsp_to_ide(t.enc(), r.end));
        // (name, kind, detail, range, selection range) of every declaration.
        let mut symbols = Vec::new();
        match r {
            Ok(Some(lsp::DocumentSymbolResponse::Nested(nested))) => {
                let mut stack = nested;
                while let Some(s) = stack.pop() {
                    symbols.push((s.name, s.kind, s.detail, range(s.range), range(s.selection_range)));
                    stack.extend(s.children.unwrap_or_default());
                }
            }
            #[allow(deprecated)]
            Ok(Some(lsp::DocumentSymbolResponse::Flat(flat))) => {
                for s in flat {
                    let r = range(s.location.range);
                    symbols.push((s.name, s.kind, None, r, r));
                }
            }
            _ => return Vec::new(),
        }
        let contains =
            |outer: &ide_core::Range, inner: &ide_core::Range| outer.start <= inner.start && inner.end <= outer.end;
        let mut items: Vec<HierarchyItem> = Vec::new();
        for call in calls {
            // The innermost function or method; a package-level declaration otherwise.
            let callable = |k: lsp::SymbolKind| matches!(k, lsp::SymbolKind::FUNCTION | lsp::SymbolKind::METHOD);
            let innermost = |pick: &dyn Fn(lsp::SymbolKind) -> bool| {
                symbols
                    .iter()
                    .filter(|(_, kind, _, r, _)| pick(*kind) && contains(r, call))
                    .min_by_key(|(_, _, _, r, _)| (r.end.line - r.start.line, r.end.col.saturating_sub(r.start.col)))
            };
            let Some((name, kind, detail, r, selection)) = innermost(&callable).or_else(|| innermost(&|_| true)) else {
                continue;
            };
            match items.iter_mut().find(|i| i.range == *r && i.name == *name) {
                Some(item) => item.from_ranges.push(*call),
                None => items.push(HierarchyItem {
                    name: name.clone(),
                    kind: crate::convert::symbol_kind(*kind),
                    detail: detail.clone(),
                    path: path.to_path_buf().into(),
                    uri: None,
                    range: *r,
                    selection_range: *selection,
                    from_ranges: vec![*call],
                }),
            }
        }
        items
    }

    /// Opens `files` on `t` (read from disk) unless the user has them open;
    /// they are closed when the returned guard drops. Files too large or not
    /// readable as text are left out and flagged on the guard.
    async fn open_transient(&self, t: &Target, files: Vec<PathBuf>, cancel: &CancellationToken) -> TransientFiles<'_> {
        // The server already sees the user's files, however large.
        let open: HashSet<PathBuf> = self.docs.lock().values().map(|d| d.canonical.clone()).collect();
        let (read, skipped) = {
            let cancel = cancel.clone();
            tokio::task::spawn_blocking(move || {
                let mut read = Vec::new();
                let mut skipped = false;
                for f in files {
                    if cancel.is_cancelled() {
                        break;
                    }
                    let canonical = dunce::canonicalize(&f).unwrap_or_else(|_| f.clone());
                    if open.contains(&canonical) {
                        continue;
                    }
                    // A file gone since the search no longer mentions anything.
                    let Ok(meta) = std::fs::metadata(&f) else { continue };
                    if !meta.is_file() {
                        continue;
                    }
                    match (meta.len() <= MAX_CANDIDATE_BYTES).then(|| std::fs::read_to_string(&f)) {
                        Some(Ok(text)) => read.push((f, canonical, text)),
                        _ => skipped = true,
                    }
                }
                (read, skipped)
            })
            .await
            .unwrap_or_default()
        };
        let mut guard = TransientFiles::empty(self, t);
        guard.skipped = skipped;
        if cancel.is_cancelled() {
            return guard;
        }
        let docs = self.docs.lock();
        for (path, canonical, text) in read {
            if docs.values().any(|d| d.canonical == canonical) {
                continue;
            }
            let uri = crate::uri::path_to_uri(&path);
            if t.server.hold_transient(&path, t.run.generation) {
                let language = self.languages.detect(&path, text.lines().next());
                let params = json!({
                    "textDocument": { "uri": uri, "languageId": language.as_str(), "version": 0, "text": text }
                });
                if let Err(e) = t.run.peer.notify("textDocument/didOpen", params) {
                    tracing::debug!("{}: didOpen: {e}", t.server.name);
                }
            }
            guard.files.push((path, uri));
        }
        guard
    }
}

/// Files opened by [`LspManager::open_transient`]; closed on drop.
pub(crate) struct TransientFiles<'a> {
    mgr: &'a LspManager,
    server: Arc<Server>,
    run: Running,
    pub files: Vec<(PathBuf, lsp::Uri)>,
    /// Candidates that could not be opened.
    pub skipped: bool,
}

impl TransientFiles<'_> {
    /// Opens one file outside a references search (a file operation needs a loaded project).
    pub(crate) fn hold(&mut self, path: &Path, language: &LanguageId, text: &str) {
        let _docs = self.mgr.docs.lock();
        let uri = crate::uri::path_to_uri(path);
        if self.server.hold_transient(path, self.run.generation) {
            let params =
                json!({ "textDocument": { "uri": uri, "languageId": language.as_str(), "version": 0, "text": text } });
            if let Err(e) = self.run.peer.notify("textDocument/didOpen", params) {
                tracing::debug!("{}: didOpen: {e}", self.server.name);
            }
        }
        self.files.push((path.to_owned(), uri));
    }
}

impl<'a> TransientFiles<'a> {
    pub(crate) fn empty(mgr: &'a LspManager, t: &Target) -> Self {
        Self { mgr, server: t.server.clone(), run: t.run.clone(), files: Vec::new(), skipped: false }
    }
}

impl Drop for TransientFiles<'_> {
    fn drop(&mut self) {
        if self.files.is_empty() {
            return;
        }
        // Under the documents lock, so a user `didOpen` of the same file can't interleave.
        let _docs = self.mgr.docs.lock();
        for (path, uri) in self.files.drain(..) {
            if self.server.release_transient(&path, self.run.generation)
                && let Err(e) = self.run.peer.notify("textDocument/didClose", json!({ "textDocument": { "uri": uri } }))
            {
                tracing::debug!("{}: didClose: {e}", self.server.name);
            }
        }
    }
}
