use super::Emit;
use crate::Host;
use ide_core::{IdeResult, RequestId};
use ide_search::{FileMatches, ProjectFileSet, SearchQuery, SearchSummary};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SearchEvent {
    File { file: FileMatches },
    Done { summary: SearchSummary },
}

pub fn literal_range(l: ide_language::Literal) -> ide_search::LiteralRange {
    let kind = match l.kind {
        ide_language::LiteralKind::Comment => ide_search::LiteralKind::Comment,
        ide_language::LiteralKind::String => ide_search::LiteralKind::String,
    };
    ide_search::LiteralRange { start: l.start, end: l.end, kind }
}

/// Find in Files. Results stream through `on_event`; ends with `Done`.
/// Cancel with `cancel_request(request)`.
pub async fn start(
    host: &Host,
    window: &str,
    request: RequestId,
    mut query: SearchQuery,
    on_event: Emit<SearchEvent>,
) -> IdeResult<()> {
    let project = host.project(window)?;
    // Excluded roots (Project Structure marks and detected `target`, `node_modules`, …) and
    // ignored names are never searched.
    query.exclude.extend(project.search_excludes());
    let cancel = host.begin_request(request);
    let events = on_event.clone();
    let syntax = host.syntax();
    let summary = host
        .blocking(move || {
            search_project(&project, &syntax, &query, &cancel, &|file| events(SearchEvent::File { file }))
        })
        .await;
    host.end_request(request);
    on_event(SearchEvent::Done { summary: summary? });
    Ok(())
}

/// Shared Find in Files engine: project excludes are added by the caller.
pub(crate) fn search_project(
    project: &crate::project::Project,
    syntax: &ide_language::Syntax,
    query: &SearchQuery,
    cancel: &ide_core::CancellationToken,
    emit: &(dyn Fn(FileMatches) + Sync),
) -> IdeResult<SearchSummary> {
    let root = &project.root;
    let roots = project.roots();
    let set = match query.scope {
        ide_search::SearchScope::FileSet { set } => Some(set),
        _ => None,
    };
    let workspace = ide_workspace::workspace::Workspace::load(root)?.is_some_and(|w| w.is_container(root));
    let include_root = !workspace
        || matches!(query.scope, ide_search::SearchScope::Directory { .. } | ide_search::SearchScope::Files { .. });
    let content_roots = match query.scope {
        ide_search::SearchScope::Project
        | ide_search::SearchScope::FileSet { .. }
        | ide_search::SearchScope::Pattern { .. } => project.content_roots(),
        _ => Vec::new(),
    };
    let filter = |rel: &str| match set {
        Some(ProjectFileSet::Production) => !roots.is_test(rel),
        Some(ProjectFileSet::Test) => roots.is_test(rel),
        _ => true,
    };
    let literals = |path: &Path, text: &str| {
        let language = project.languages.detect(path, text.lines().next());
        Some(syntax.literals(&language, text)?.into_iter().map(literal_range).collect())
    };
    let defaults = project.documents.file_defaults();
    let decode = |path: &Path, bytes: &[u8]| ide_vfs::decode_text(bytes, defaults.fallback_for(path));
    let mut total = SearchSummary::default();
    for dir in std::iter::once(root).filter(|_| include_root).chain(&content_roots) {
        let mut remaining = query.clone();
        let max = if query.max_matches == 0 { 10_000 } else { query.max_matches };
        remaining.max_matches = max.saturating_sub(total.matches).max(1);
        let summary = ide_search::search_in_context(
            dir,
            &remaining,
            Some(&filter),
            Some(&literals),
            ide_search::TextSource { overlay: &|p| project.documents.search_text_of(p), decode: &decode },
            cancel,
            &|mut file| {
                if dir != root {
                    let name = dir.file_name().unwrap_or_default().to_string_lossy();
                    file.rel_path = format!("{name}/{}", file.rel_path);
                }
                emit(file);
            },
        )?;
        total.files += summary.files;
        total.matches += summary.matches;
        total.elapsed_ms += summary.elapsed_ms;
        total.limit_hit |= summary.limit_hit || total.matches >= max;
        total.cancelled |= summary.cancelled;
        if total.limit_hit || total.cancelled {
            break;
        }
    }
    Ok(total)
}

mod commands;
pub use commands::*;
