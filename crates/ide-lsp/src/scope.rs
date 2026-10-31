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
use crate::types::ReferencesIncomplete;
use crate::{DocSnap, LspManager, Target};
use ide_core::{CancellationToken, IdeError, IdeResult, LanguageId, Pos};
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
        let word = search_word(snap, pos).filter(|_| t.caps().open_close);
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

    /// Opens `files` on `t` (read from disk) unless the user has them open;
    /// they are closed when the returned guard drops. Files too large or not
    /// readable as text are left out and flagged on the guard.
    async fn open_transient(&self, t: &Target, files: Vec<PathBuf>, cancel: &CancellationToken) -> TransientFiles<'_> {
        // The server already sees the user's files, however large.
        let key = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        let open: HashSet<PathBuf> = self.docs.lock().values().map(|d| key(&d.path)).collect();
        let (read, skipped) = {
            let cancel = cancel.clone();
            tokio::task::spawn_blocking(move || {
                let mut read = Vec::new();
                let mut skipped = false;
                for f in files.into_iter().filter(|f| !open.contains(&key(f))) {
                    if cancel.is_cancelled() {
                        break;
                    }
                    // A file gone since the search no longer mentions anything.
                    let Ok(meta) = std::fs::metadata(&f) else { continue };
                    if !meta.is_file() {
                        continue;
                    }
                    match (meta.len() <= MAX_CANDIDATE_BYTES).then(|| std::fs::read_to_string(&f)) {
                        Some(Ok(text)) => read.push((f, text)),
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
        for (path, text) in read {
            if docs.values().any(|d| key(&d.path) == key(&path)) {
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
