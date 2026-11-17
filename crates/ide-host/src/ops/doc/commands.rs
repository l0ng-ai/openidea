use crate::Host;
use ide_command::command;
use ide_core::{DocId, IdeError, IdeResult, OutlineItem, Range};
use ide_language::{FoldRange, SyntaxHighlights};
use ide_text::LineEnding;
use ide_workspace::{DocumentEncoding, DocumentInfo, DocumentLanguage, HistoryEntry};
use std::path::PathBuf;

/// Runs blocking work (disk I/O, parsing, large copies) on the blocking pool,
/// keeping it off the main thread and the async runtime's workers.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

/// Opens a read-only virtual document (see `lsp_virtual_document`) as an
/// editor buffer, so syntax features and language-server requests work in it.
#[command(trust = always)]
pub async fn doc_open_virtual(host: &Host, window: &str, uri: String) -> IdeResult<DocumentInfo> {
    let project = host.project(window)?;
    let vd = crate::ops::lsp::lsp_virtual_document(host, window, uri).await?;
    blocking(move || {
        project.documents.open_virtual(
            &vd.uri,
            vd.language_id,
            &vd.text,
            &vd.encoding,
            vd.has_bom,
            vd.can_reload_encoding,
        )
    })
    .await
}

/// The language and CodeMirror mode `path` is shown with in an editor, without opening
/// it: previews of closed files and diffs. `first_line` is the shown text's (a revision's)
/// for hashbang detection; without it the file's on disk counts.
#[command(trust = always)]
pub async fn doc_language(
    host: &Host,
    window: &str,
    path: PathBuf,
    first_line: Option<String>,
) -> IdeResult<DocumentLanguage> {
    let project = host.project(window)?;
    blocking(move || Ok(project.documents.language_of(&path, first_line.as_deref()))).await
}

/// "Reload with Encoding" (`reload`) or "Convert to Encoding"; returns the new encoding and BOM state.
#[command(trust = always)]
pub async fn doc_set_encoding(
    host: &Host,
    window: &str,
    doc: DocId,
    encoding: String,
    reload: bool,
) -> IdeResult<DocumentEncoding> {
    // Virtual documents re-read their origin (archive, language server, Git blob)
    // instead of a disk file; converting them would write to it, so it stays refused.
    let project = host.project(window)?;
    if reload
        && !project.documents.is_untitled(doc)?
        && let Some(uri) = project.documents.virtual_uri(doc)?
    {
        let vd = if uri.starts_with("git-revision:") {
            crate::ops::vcs::revision_virtual_document(host, window, &uri, Some(&encoding)).await?
        } else {
            project.lsp.reload_virtual(&uri, &encoding).await?
        };
        return host.blocking(move || project.documents.replace_virtual(doc, &vd.text, &vd.encoding, vd.has_bom)).await;
    }
    host.blocking(move || project.documents.set_encoding(doc, &encoding, reload)).await
}

#[command(trust = always)]
pub async fn doc_set_bom(host: &Host, window: &str, doc: DocId, has_bom: bool) -> IdeResult<DocumentEncoding> {
    // Adds or removes the BOM on a UTF-8 document; the change is written on save.
    let project = host.project(window)?;
    host.blocking(move || project.documents.set_bom(doc, has_bom)).await
}

#[command(trust = always)]
pub async fn doc_set_line_ending(host: &Host, window: &str, doc: DocId, line_ending: LineEnding) -> IdeResult<()> {
    let project = host.project(window)?;
    blocking(move || project.documents.set_line_ending(doc, line_ending)).await
}

/// Structure view: LSP document symbols when available (with tree-sitter
/// visibility), tree-sitter otherwise.
/// Tree-sitter answers come from the per-document tree cache (incremental
/// re-parse); large documents get no syntax structure.
#[command(trust = always)]
pub async fn doc_outline(host: &Host, window: &str, doc: DocId) -> IdeResult<Vec<OutlineItem>> {
    let project = host.project(window)?;
    let lsp = project.lsp.document_symbols(doc).await.ok().flatten();
    let lsp = if lsp.as_ref().is_none_or(|v| v.is_empty()) {
        if let Some((plugins, d)) =
            crate::ops::lsp::plugin_providers(host, window, doc, crate::plugins::ProviderKind::DocumentSymbols)
        {
            let items =
                crate::ops::lsp::plugin_call(move || plugins.language_document_symbols(&d)).await.unwrap_or_default();
            if items.is_empty() { lsp } else { Some(crate::plugins::language_features::outline(items)) }
        } else {
            lsp
        }
    } else {
        lsp
    };
    let lsp = lsp.filter(|v| !v.is_empty());
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

#[command(trust = always)]
pub async fn doc_folding(host: &Host, window: &str, doc: DocId) -> IdeResult<Vec<FoldRange>> {
    let project = host.project(window)?;
    blocking(move || {
        let snap = project.documents.text_snapshot(doc)?;
        if snap.large {
            return Ok(Vec::new());
        }
        let mut folds = project.syntax.folding(doc, &snap.language, snap.version, &snap.text);
        if let Some(plugins) = crate::plugins::editor_providers_for(crate::plugins::ProviderKind::Folding) {
            let d = ide_plugin::ProviderDocument {
                path: project.documents.identity(doc)?.0,
                language: snap.language.0,
                version: u64::from(snap.version),
                text: snap.text,
            };
            folds.extend(plugins.language_folding(&d).into_iter().map(|f| FoldRange {
                start_line: f.start_line,
                end_line: f.end_line,
                kind: match f.kind.as_str() {
                    "comment" => ide_language::FoldKind::Comment,
                    "imports" => ide_language::FoldKind::Imports,
                    _ => ide_language::FoldKind::Region,
                },
            }));
            folds.sort_by_key(|f| (f.start_line, f.end_line));
            folds.dedup_by_key(|f| (f.start_line, f.end_line));
        }
        Ok(folds)
    })
    .await
}

/// Tree-sitter highlighting for languages the UI has no CodeMirror mode for;
/// empty when the grammar has no highlights query or the document is large.
#[command(trust = always)]
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

/// Python class facts for the inheritance inspections: tree-sitter, no language server.
#[command(trust = always)]
pub async fn doc_python_facts(host: &Host, window: &str, doc: DocId) -> IdeResult<ide_language::PythonFacts> {
    // Base names as written, a method's parameters, decorator semantics and its body shape.
    let project = host.project(window)?;
    let syntax = host.syntax();
    let snap = project.documents.text_snapshot(doc)?;
    blocking(move || Ok(syntax.python_facts(&snap.language, &snap.text))).await
}

/// Extend Selection (⌥↑): syntax ranges around `offset`, innermost first.
/// Large documents fall back to word / line / document ranges.
#[command(trust = always)]
pub async fn doc_selection_ranges(host: &Host, window: &str, doc: DocId, offset: u32) -> IdeResult<Vec<Range>> {
    let project = host.project(window)?;
    blocking(move || {
        let snap = project.documents.text_snapshot(doc)?;
        if !snap.large
            && let Some(plugins) = crate::plugins::editor_providers_for(crate::plugins::ProviderKind::SelectionRanges)
        {
            let at = ide_text::Document::new(&snap.text).offset_to_pos(offset);
            let d = ide_plugin::ProviderDocument {
                path: project.documents.identity(doc)?.0,
                language: snap.language.0.clone(),
                version: u64::from(snap.version),
                text: snap.text.clone(),
            };
            let ranges = plugins.language_selection_ranges(&d, at);
            if !ranges.is_empty() {
                return Ok(ranges);
            }
        }
        let language = if snap.large { ide_core::LanguageId::plain_text() } else { snap.language };
        Ok(project.syntax.selection_ranges(doc, &language, snap.version, &snap.text, offset))
    })
    .await
}

#[command(trust = always)]
pub async fn history_list(host: &Host, window: &str, path: PathBuf) -> IdeResult<Vec<HistoryEntry>> {
    let project = host.project(window)?;
    blocking(move || project.history.list(&path)).await
}

#[command(trust = always)]
pub async fn history_content(host: &Host, window: &str, id: String) -> IdeResult<String> {
    let project = host.project(window)?;
    blocking(move || project.history.content(&id)).await
}

ide_command::domain!(
    doc_commands:
    doc_folding,
    doc_highlights,
    doc_language,
    doc_open_virtual,
    doc_outline,
    doc_python_facts,
    doc_selection_ranges,
    doc_set_bom,
    doc_set_encoding,
    doc_set_line_ending,
    history_content,
    history_list,
);
