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
    let roots = project.roots();
    let set = match query.scope {
        ide_search::SearchScope::FileSet { set } => Some(set),
        _ => None,
    };
    let cancel = host.begin_request(request);
    let documents = project.documents.clone();
    let root = project.root.clone();
    // The whole project also covers the Project Structure content roots.
    let content_roots = match query.scope {
        ide_search::SearchScope::Project | ide_search::SearchScope::FileSet { set: ProjectFileSet::All } => {
            project.content_roots()
        }
        _ => Vec::new(),
    };
    let languages = project.languages.clone();
    let syntax = host.syntax();
    let events = on_event.clone();
    let summary = host
        .blocking(move || {
            let filter = |rel: &str| match set {
                Some(ProjectFileSet::Production) => !roots.is_test(rel),
                Some(ProjectFileSet::Test) => roots.is_test(rel),
                Some(ProjectFileSet::All) | None => true,
            };
            // Comments and string literals for the search context filter.
            let literals = |path: &Path, text: &str| {
                let language = languages.detect(path, text.lines().next());
                let found = syntax.literals(&language, text)?;
                Some(found.into_iter().map(literal_range).collect())
            };
            let mut total = SearchSummary::default();
            for dir in std::iter::once(&root).chain(&content_roots) {
                let s = ide_search::search_in_context(
                    dir,
                    &query,
                    Some(&filter),
                    Some(&literals),
                    &|p| documents.text_of(p),
                    &cancel,
                    &|file| events(SearchEvent::File { file }),
                )?;
                total.files += s.files;
                total.matches += s.matches;
                total.elapsed_ms += s.elapsed_ms;
                total.limit_hit |= s.limit_hit;
                total.cancelled |= s.cancelled;
                if total.limit_hit || total.cancelled {
                    break;
                }
            }
            Ok(total)
        })
        .await;
    host.end_request(request);
    on_event(SearchEvent::Done { summary: summary? });
    Ok(())
}

mod commands;
pub use commands::*;
