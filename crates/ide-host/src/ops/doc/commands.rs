#[allow(unused_imports)]
use super::*;
use crate::Host;
use crate::rpc::Dispatcher;
use ide_core::{DocId, IdeError, IdeResult, OutlineItem, Range};
use ide_language::{FoldRange, SyntaxHighlights};
use ide_text::LineEnding;
use ide_workspace::{DocumentInfo, HistoryEntry};
use std::path::PathBuf;

/// Runs blocking work (disk I/O, parsing, large copies) on the blocking pool,
/// keeping it off the main thread and the async runtime's workers.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

/// Opens a read-only virtual document (see `lsp_virtual_document`) as an
/// editor buffer, so syntax features and language-server requests work in it.
pub async fn doc_open_virtual(host: &Host, window: &str, uri: String) -> IdeResult<DocumentInfo> {
    let project = host.project(window)?;
    let vd = project.lsp.virtual_document(&uri).await?;
    blocking(move || project.documents.open_virtual(&vd.uri, vd.language_id, &vd.text)).await
}

/// The CodeMirror mode `path` gets when opened (`DocumentInfo::ui_mode`),
/// without opening it: previews of closed files.
pub async fn doc_ui_mode(host: &Host, window: &str, path: PathBuf) -> IdeResult<Option<String>> {
    let project = host.project(window)?;
    blocking(move || Ok(project.documents.ui_mode_of(&path))).await
}

/// "Reload with Encoding" (`reload`) or "Convert to Encoding"; returns the new encoding label.
pub fn doc_set_encoding(host: &Host, window: &str, doc: DocId, encoding: String, reload: bool) -> IdeResult<String> {
    host.project(window)?.documents.set_encoding(doc, &encoding, reload)
}

pub fn doc_set_line_ending(host: &Host, window: &str, doc: DocId, line_ending: LineEnding) -> IdeResult<()> {
    host.project(window)?.documents.set_line_ending(doc, line_ending)
}

/// Structure view: LSP document symbols when available (with tree-sitter
/// visibility), tree-sitter otherwise.
/// Tree-sitter answers come from the per-document tree cache (incremental
/// re-parse); large documents get no syntax structure.
pub async fn doc_outline(host: &Host, window: &str, doc: DocId) -> IdeResult<Vec<OutlineItem>> {
    let project = host.project(window)?;
    let lsp = project.lsp.document_symbols(doc).await.ok().flatten();
    blocking(move || {
        let snap = match project.documents.text_snapshot(doc) {
            Ok(snap) => snap,
            Err(e) => return lsp.ok_or(e),
        };
        let syntax = || project.syntax.outline(doc, &snap.language, snap.version, &snap.text);
        Ok(match lsp {
            // Server symbols carry no visibility; borrow it from the syntax tree.
            Some(mut items) => {
                if !snap.large {
                    ide_language::merge_visibility(&mut items, &syntax());
                }
                items
            }
            None if snap.large => Vec::new(),
            None => syntax(),
        })
    })
    .await
}

pub async fn doc_folding(host: &Host, window: &str, doc: DocId) -> IdeResult<Vec<FoldRange>> {
    let project = host.project(window)?;
    blocking(move || {
        let snap = project.documents.text_snapshot(doc)?;
        if snap.large {
            return Ok(Vec::new());
        }
        Ok(project.syntax.folding(doc, &snap.language, snap.version, &snap.text))
    })
    .await
}

/// Tree-sitter highlighting for languages the UI has no CodeMirror mode for;
/// empty when the grammar has no highlights query or the document is large.
pub async fn doc_highlights(host: &Host, window: &str, doc: DocId) -> IdeResult<SyntaxHighlights> {
    let project = host.project(window)?;
    blocking(move || {
        let snap = project.documents.text_snapshot(doc)?;
        if snap.large {
            return Ok(SyntaxHighlights::default());
        }
        Ok(project.syntax.highlights(doc, &snap.language, snap.version, &snap.text))
    })
    .await
}

/// Extend Selection (⌥↑): syntax ranges around `offset`, innermost first.
/// Large documents fall back to word / line / document ranges.
pub async fn doc_selection_ranges(host: &Host, window: &str, doc: DocId, offset: u32) -> IdeResult<Vec<Range>> {
    let project = host.project(window)?;
    blocking(move || {
        let snap = project.documents.text_snapshot(doc)?;
        let language = if snap.large { ide_core::LanguageId::plain_text() } else { snap.language };
        Ok(project.syntax.selection_ranges(doc, &language, snap.version, &snap.text, offset))
    })
    .await
}

pub fn history_list(host: &Host, window: &str, path: PathBuf) -> IdeResult<Vec<HistoryEntry>> {
    host.project(window)?.history.list(&path)
}

pub fn history_content(host: &Host, window: &str, id: String) -> IdeResult<String> {
    host.project(window)?.history.content(&id)
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("doc_open_virtual", |c| async move { doc_open_virtual(&c.host, &c.window, c.arg("uri")?).await });
    d.add("doc_ui_mode", |c| async move { doc_ui_mode(&c.host, &c.window, c.arg("path")?).await });
    d.add("doc_set_encoding", |c| async move {
        doc_set_encoding(&c.host, &c.window, c.arg("doc")?, c.arg("encoding")?, c.arg("reload")?)
    });
    d.add("doc_set_line_ending", |c| async move {
        doc_set_line_ending(&c.host, &c.window, c.arg("doc")?, c.arg("lineEnding")?)
    });
    d.add("doc_outline", |c| async move { doc_outline(&c.host, &c.window, c.arg("doc")?).await });
    d.add("doc_folding", |c| async move { doc_folding(&c.host, &c.window, c.arg("doc")?).await });
    d.add("doc_highlights", |c| async move { doc_highlights(&c.host, &c.window, c.arg("doc")?).await });
    d.add("doc_selection_ranges", |c| async move {
        doc_selection_ranges(&c.host, &c.window, c.arg("doc")?, c.arg("offset")?).await
    });
    d.add("history_list", |c| async move { history_list(&c.host, &c.window, c.arg("path")?) });
    d.add("history_content", |c| async move { history_content(&c.host, &c.window, c.arg("id")?) });
}
