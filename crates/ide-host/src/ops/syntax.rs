//! Tree-sitter structure queries (`ide-syntax`): the fallback editor features
//! use when the language server is unavailable, not ready or failing.
//!
//! All positions are 0-based lines / UTF-16 columns. Document queries run on
//! the blocking pool against the document's cached, incrementally re-parsed
//! tree; an optional `request` id makes them cancellable via `cancel_request`.
//! Languages without a grammar (and documents too large to parse) reject with
//! `unavailable`.
use crate::Host;
use crate::Project;
use crate::rpc::Dispatcher;

use super::doc::blocking;
use ide_core::{CancellationToken, DocId, IdeError, IdeResult, LanguageId, Pos, Range, RequestId};
use ide_syntax::{
    ExpressionAt, FileIdentifiers, IdentifierOccurrence, Locals, NodeAt, Snapshot, StructuralRanges, StructureResult,
    StructureService, StructureSupport, SyntaxErrors,
};
use std::path::PathBuf;
use std::sync::Arc;

/// Runs `f` on the current snapshot of `doc` off the command thread.
async fn on_doc<T: Send + 'static>(
    host: &Host,
    window: &str,
    doc: DocId,
    request: Option<RequestId>,
    f: impl FnOnce(&StructureService, &Snapshot, &CancellationToken) -> StructureResult<T> + Send + 'static,
) -> IdeResult<T> {
    let project: Arc<Project> = host.project(window)?;
    let cancel = request.map_or_else(CancellationToken::new, |id| host.begin_request(id));
    let result = blocking(move || {
        let snap = project.documents.text_snapshot(doc)?;
        if snap.large {
            return Err(IdeError::unavailable("file is too large for syntax analysis"));
        }
        let s = Snapshot::doc(doc, snap.version, &snap.language, &snap.text);
        Ok(f(&project.structure, &s, &cancel)?)
    })
    .await;
    if let Some(id) = request {
        host.end_request(id);
    }
    result
}

/// What the structure service supports for a language (`tree`: every query,
/// `locals`: scope analysis).
pub fn syntax_support(host: &Host, window: &str, language: LanguageId) -> IdeResult<StructureSupport> {
    Ok(host.project(window)?.structure.support(&language))
}

/// The smallest named node covering `range`, with its ancestors (parent first).
pub async fn syntax_node_at(
    host: &Host,
    window: &str,
    doc: DocId,
    range: Range,
    request: Option<RequestId>,
) -> IdeResult<Option<NodeAt>> {
    on_doc(host, window, doc, request, move |s, snap, c| s.node_at(snap, range, c)).await
}

/// The expression a selection denotes (exact or minimally enclosing), with its
/// statement, block and caret candidates.
pub async fn syntax_expression_at(
    host: &Host,
    window: &str,
    doc: DocId,
    range: Range,
    request: Option<RequestId>,
) -> IdeResult<ExpressionAt> {
    on_doc(host, window, doc, request, move |s, snap, c| s.expression_at(snap, range, c)).await
}

/// `ERROR` / `MISSING` nodes (e.g. a missing `;`) in document order.
pub async fn syntax_errors(
    host: &Host,
    window: &str,
    doc: DocId,
    request: Option<RequestId>,
) -> IdeResult<SyntaxErrors> {
    on_doc(host, window, doc, request, |s, snap, c| s.syntax_errors(snap, c)).await
}

/// Scope analysis of the identifier at `pos`: its local definition and
/// references, or why it is not a local.
pub async fn syntax_locals(
    host: &Host,
    window: &str,
    doc: DocId,
    pos: Pos,
    request: Option<RequestId>,
) -> IdeResult<Locals> {
    on_doc(host, window, doc, request, move |s, snap, c| s.locals(snap, pos, c)).await
}

/// Identifier tokens spelled `name` in a document, excluding comments and strings.
pub async fn syntax_identifiers(
    host: &Host,
    window: &str,
    doc: DocId,
    name: String,
    request: Option<RequestId>,
) -> IdeResult<Vec<IdentifierOccurrence>> {
    on_doc(host, window, doc, request, move |s, snap, c| s.identifiers_named(snap, &name, c)).await
}

/// [`syntax_identifiers`] over files (open buffers win over disk); files
/// without occurrences or without a grammar are left out. Cancellable.
pub async fn syntax_identifiers_in_files(
    host: &Host,
    window: &str,
    paths: Vec<PathBuf>,
    name: String,
    request: RequestId,
) -> IdeResult<Vec<FileIdentifiers>> {
    let project = host.project(window)?;
    let languages = project.languages.clone();
    let cancel = host.begin_request(request);
    let result = blocking(move || {
        let load = |path: &std::path::Path| {
            if let Some(doc) = project.documents.by_path(path) {
                let snap = project.documents.text_snapshot(doc).ok()?;
                return (!snap.large).then_some((snap.language, Some((doc, snap.version)), snap.text));
            }
            let text = ide_vfs::load_text(path).ok()?.text;
            let first_line = text.lines().next();
            Some((languages.detect(path, first_line), None, text))
        };
        Ok(project.structure.identifiers_in_files(&paths, &name, load, &cancel)?)
    })
    .await;
    host.end_request(request);
    result
}

/// Extend Selection chain plus statement / declaration ranges at `pos`
/// (Move Statement, Complete Statement for languages without a Lezer grammar).
pub async fn syntax_structural_ranges(
    host: &Host,
    window: &str,
    doc: DocId,
    pos: Pos,
    request: Option<RequestId>,
) -> IdeResult<StructuralRanges> {
    on_doc(host, window, doc, request, move |s, snap, c| s.structural_ranges(snap, pos, c)).await
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("syntax_support", |c| async move { syntax_support(&c.host, &c.window, c.arg("language")?) });
    d.add("syntax_node_at", |c| async move {
        syntax_node_at(&c.host, &c.window, c.arg("doc")?, c.arg("range")?, c.arg("request")?).await
    });
    d.add("syntax_expression_at", |c| async move {
        syntax_expression_at(&c.host, &c.window, c.arg("doc")?, c.arg("range")?, c.arg("request")?).await
    });
    d.add(
        "syntax_errors",
        |c| async move { syntax_errors(&c.host, &c.window, c.arg("doc")?, c.arg("request")?).await },
    );
    d.add("syntax_locals", |c| async move {
        syntax_locals(&c.host, &c.window, c.arg("doc")?, c.arg("pos")?, c.arg("request")?).await
    });
    d.add("syntax_identifiers", |c| async move {
        syntax_identifiers(&c.host, &c.window, c.arg("doc")?, c.arg("name")?, c.arg("request")?).await
    });
    d.add("syntax_identifiers_in_files", |c| async move {
        syntax_identifiers_in_files(&c.host, &c.window, c.arg("paths")?, c.arg("name")?, c.arg("request")?).await
    });
    d.add("syntax_structural_ranges", |c| async move {
        syntax_structural_ranges(&c.host, &c.window, c.arg("doc")?, c.arg("pos")?, c.arg("request")?).await
    });
}
