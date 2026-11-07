//! In-process language services, consulted before the language servers.
//!
//! A [`LanguageService`] answers editor requests for the documents of one
//! language (the native PHP engine, `ide-php`). `ops/lsp.rs` asks the service
//! registered for a document's language first and falls back to
//! [`ide_lsp::LspManager`] when it returns `None` ("not handled"), so local and
//! remote development behave alike and the frontend doesn't change.
//!
//! The methods mirror the `LspManager` feature methods `ops/lsp.rs` uses. They
//! are synchronous: the dispatch runs them on a blocking thread, and long ones
//! honour the `CancellationToken` they get.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use ide_core::{
    CancellationToken, DocId, IdeResult, LanguageId, Location, OutlineItem, Pos, Range, TextEdit, WorkspaceEdit,
};
use ide_lsp::types::*;
use parking_lot::RwLock;

/// A service's answer: `None` when it doesn't handle the request, which then
/// goes to the language servers.
pub type Answer<T> = Option<IdeResult<T>>;

/// Editor requests answered in-process. Every method defaults to "not handled".
#[allow(unused_variables)]
pub trait LanguageService: Send + Sync {
    fn completion(
        &self,
        doc: DocId,
        pos: Pos,
        trigger: Option<&str>,
        cancel: &CancellationToken,
    ) -> Answer<CompletionList> {
        None
    }

    fn inline_completion(
        &self,
        doc: DocId,
        pos: Pos,
        automatic: bool,
        cancel: &CancellationToken,
    ) -> Answer<Vec<InlineCompletionItem>> {
        None
    }

    fn resolve_completion(&self, doc: DocId, item: &CompletionItem) -> Answer<CompletionItem> {
        None
    }

    fn hover(&self, doc: DocId, pos: Pos, cancel: &CancellationToken) -> Answer<Option<Hover>> {
        None
    }

    fn signature_help(&self, doc: DocId, pos: Pos) -> Answer<Option<SignatureHelp>> {
        None
    }

    fn goto(&self, doc: DocId, pos: Pos, kind: GotoKind) -> Answer<Vec<Location>> {
        None
    }

    fn implementations(&self, doc: DocId, positions: &[Pos], cancel: &CancellationToken) -> Answer<Vec<Vec<Location>>> {
        None
    }

    fn references(
        &self,
        doc: DocId,
        pos: Pos,
        include_declaration: bool,
        project_wide: bool,
        cancel: &CancellationToken,
    ) -> Answer<References> {
        None
    }

    fn document_highlights(&self, doc: DocId, pos: Pos) -> Answer<Vec<Highlight>> {
        None
    }

    /// The Structure view and breadcrumbs (`doc_outline`).
    fn document_symbols(&self, doc: DocId) -> Answer<Option<Vec<OutlineItem>>> {
        None
    }

    /// Symbols of the whole project. Not tied to a document: every service is
    /// asked, and their symbols join the language servers'.
    fn workspace_symbols(&self, query: &str, cancel: &CancellationToken) -> Answer<Vec<WorkspaceSymbol>> {
        None
    }

    fn code_actions(&self, doc: DocId, range: Range, only: &[String]) -> Answer<Vec<CodeAction>> {
        None
    }

    fn code_action_query(
        &self,
        doc: DocId,
        range: Range,
        only: &[String],
        cancel: &CancellationToken,
    ) -> Answer<CodeActionQuery> {
        None
    }

    /// Computes the edit of a code action this service offered without one
    /// (its `data` says what to do; Change Signature's dialog fills it in).
    /// `None` for actions it didn't offer.
    fn resolve_code_action(&self, doc: DocId, action: &CodeAction, cancel: &CancellationToken) -> Answer<CodeAction> {
        None
    }

    /// Pull Members Up / Push Members Down: the class at `pos` and what can move.
    fn hierarchy_members(
        &self,
        doc: DocId,
        pos: Pos,
        kind: HierarchyRefactoring,
        cancel: &CancellationToken,
    ) -> Answer<HierarchyMembers> {
        None
    }

    /// Checks moving `choices` (to `target`, for pull up) and computes the
    /// edit without applying it.
    #[allow(clippy::too_many_arguments)]
    fn hierarchy_refactor(
        &self,
        doc: DocId,
        pos: Pos,
        kind: HierarchyRefactoring,
        target: Option<&str>,
        choices: &[HierarchyChoice],
        cancel: &CancellationToken,
    ) -> Answer<HierarchyRefactored> {
        None
    }

    fn prepare_rename(&self, doc: DocId, pos: Pos) -> Answer<Option<Range>> {
        None
    }

    fn rename(&self, doc: DocId, pos: Pos, new_name: &str, cancel: &CancellationToken) -> Answer<Renamed> {
        None
    }

    /// Reformat Code for the document, or for the code around `range`.
    /// `line_width` is Code Style › Hard wrap at for the document's language.
    /// Asked only when no external formatter (Prettier, oxfmt) takes the file.
    fn format(
        &self,
        doc: DocId,
        range: Option<Range>,
        options: &FormatOptions,
        line_width: u32,
    ) -> Answer<Vec<TextEdit>> {
        None
    }

    fn inlay_hints(&self, doc: DocId, range: Range) -> Answer<Vec<InlayHint>> {
        None
    }

    fn semantic_tokens(&self, doc: DocId) -> Answer<Option<SemanticTokens>> {
        None
    }

    fn code_lens(&self, doc: DocId) -> Answer<Vec<CodeLens>> {
        None
    }

    fn document_links(&self, doc: DocId) -> Answer<Vec<DocumentLink>> {
        None
    }

    fn call_hierarchy(
        &self,
        doc: DocId,
        pos: Pos,
        direction: HierarchyDirection,
        cancel: &CancellationToken,
    ) -> Answer<CallHierarchy> {
        None
    }

    fn type_hierarchy(&self, doc: DocId, pos: Pos, direction: HierarchyDirection) -> Answer<Vec<HierarchyItem>> {
        None
    }

    /// The edits keeping references intact when files or folders move
    /// (`moves`: from → to, before the move), as `workspace/willRenameFiles`
    /// answers them: in terms of the paths before the move. Not tied to a
    /// document: every service is asked, and their edits join the language
    /// servers'.
    fn will_rename_files(&self, moves: &[(PathBuf, PathBuf)], cancel: &CancellationToken) -> Answer<WorkspaceEdit> {
        None
    }
}

/// The services of a project, one per language.
#[derive(Default)]
pub struct LanguageServices {
    by_language: RwLock<HashMap<LanguageId, Arc<dyn LanguageService>>>,
}

impl LanguageServices {
    /// Registers `service` for `language`, replacing the previous one.
    pub fn register(&self, language: LanguageId, service: Arc<dyn LanguageService>) {
        self.by_language.write().insert(language, service);
    }

    /// Removes the service of `language`; its requests go to the language servers.
    pub fn unregister(&self, language: &LanguageId) -> Option<Arc<dyn LanguageService>> {
        self.by_language.write().remove(language)
    }

    pub fn get(&self, language: &LanguageId) -> Option<Arc<dyn LanguageService>> {
        self.by_language.read().get(language).cloned()
    }

    pub fn is_empty(&self) -> bool {
        self.by_language.read().is_empty()
    }

    /// Every registered service (for requests not tied to a document).
    pub fn all(&self) -> Vec<Arc<dyn LanguageService>> {
        self.by_language.read().values().cloned().collect()
    }
}

/// Asks the service registered for `doc`'s language, on a blocking thread.
/// `None` when no service is registered for it or the service doesn't handle
/// the request: the caller then asks the language servers.
pub(crate) async fn ask<T: Send + 'static>(
    project: &crate::Project,
    doc: DocId,
    request: impl FnOnce(&dyn LanguageService) -> Answer<T> + Send + 'static,
) -> Answer<T> {
    if project.services.is_empty() {
        return None;
    }
    let language = project.documents.language(doc).ok()?;
    let service = project.services.get(&language)?;
    run(move || request(&*service)).await
}

/// Asks every service (workspace symbols, file moves): the answers of those
/// that handle it.
pub(crate) async fn ask_all<T: Send + 'static>(
    project: &crate::Project,
    request: impl Fn(&dyn LanguageService) -> Answer<T> + Send + 'static,
) -> Vec<IdeResult<T>> {
    let services = project.services.all();
    if services.is_empty() {
        return Vec::new();
    }
    run(move || Some(Ok(services.iter().filter_map(|s| request(&**s)).collect::<Vec<_>>())))
        .await
        .and_then(Result::ok)
        .unwrap_or_default()
}

async fn run<T: Send + 'static>(f: impl FnOnce() -> Answer<T> + Send + 'static) -> Answer<T> {
    match tokio::task::spawn_blocking(f).await {
        Ok(answer) => answer,
        Err(e) => Some(Err(ide_core::IdeError::internal(format!("language service failed: {e}")))),
    }
}
