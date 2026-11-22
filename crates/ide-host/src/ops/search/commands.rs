use crate::Host;
use crate::ops::Channel;
use ide_command::command;
use ide_core::{IdeResult, Pos, RequestId, TextEdit};
use ide_search::{ReplaceEvent, ReplaceHost, ReplacePreview, ReplaceTarget, SearchQuery};
use ide_workspace::Documents;
use std::path::{Path, PathBuf};

struct DocumentsHost<'a>(&'a Documents);

impl ReplaceHost for DocumentsHost<'_> {
    fn edit_file(&self, path: &Path, compute: &mut dyn FnMut(&str) -> IdeResult<Vec<TextEdit>>) -> IdeResult<u32> {
        let docs = self.0;
        let (doc, transient) = match docs.by_path(path) {
            Some(doc) => (doc, false),
            None => (docs.open(path)?.id, true),
        };
        // A buffer without unsaved changes (open only for the search preview, or a clean
        // tab) is saved like a closed file; one the user is editing is left unsaved.
        let save = transient || !docs.is_dirty(doc)?;
        let result = (|| {
            // Recompute if the user typed between reading the text and applying.
            for _ in 0..3 {
                let snap = docs.text_snapshot(doc)?;
                let edits = compute(&snap.text)?;
                if edits.is_empty() {
                    return Ok(0);
                }
                if docs.text_snapshot(doc)?.version != snap.version {
                    continue;
                }
                docs.apply_edits(doc, &edits)?;
                if save {
                    docs.save(doc)?;
                }
                return Ok(edits.len() as u32);
            }
            Err(ide_core::IdeError::unavailable("the file kept changing during Replace"))
        })();
        if transient {
            docs.close(doc);
        }
        result
    }
}

/// Replace in Files. Runs off the command thread; progress streams through
/// `on_event` and ends with `Done`. Cancel with `cancel_request(request)`.
///
/// Edits go through the document layer as one patch per file, so open editors
/// update live and undo the whole file's replacements in one step. Unsaved
/// editor buffers are replaced in place and left unsaved; other open documents
/// are saved, and files that were not open are opened transiently, saved and closed.
///
/// With `all_in_scope` (Replace All after the search hit its match limit) the
/// scope is searched again without the limit and every match in it is replaced,
/// as IDEA does: `targets` then only carry the `skip` positions of their files.
#[allow(clippy::too_many_arguments)]
#[command(trust = trusted)]
pub async fn replace_in_files(
    host: &Host,
    window: &str,
    request: RequestId,
    query: SearchQuery,
    replacement: String,
    preserve_case: bool,
    targets: Vec<ReplaceTarget>,
    all_in_scope: bool,
    on_event: Channel<ReplaceEvent>,
) -> IdeResult<()> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let events = on_event.clone();
    let syntax = host.syntax();
    let summary = tokio::task::spawn_blocking(move || {
        let targets = if all_in_scope { scope_targets(&project, &syntax, &query, targets, &cancel)? } else { targets };
        let host = DocumentsHost(&project.documents);
        let literals = |path: &Path, text: &str| super::literals_of(&project, &syntax, path, text);
        ide_search::replace_files_in_context(
            &host,
            &query,
            &replacement,
            preserve_case,
            &targets,
            Some(&literals),
            &cancel,
            &|e| {
                let _ = events.send(e);
            },
        )
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()));
    host.end_request(request);
    let summary = summary??;
    let _ = on_event.send(ReplaceEvent::Done { summary });
    Ok(())
}

/// Every file of `query`'s scope with a match (no match limit), sorted, each
/// keeping the `skip` positions `listed` gives it.
fn scope_targets(
    project: &crate::project::Project,
    syntax: &ide_language::Syntax,
    query: &SearchQuery,
    listed: Vec<ReplaceTarget>,
    cancel: &ide_core::CancellationToken,
) -> IdeResult<Vec<ReplaceTarget>> {
    let mut query = query.clone();
    query.max_matches = u32::MAX;
    query.exclude.extend(project.search_excludes());
    let found = std::sync::Mutex::new(Vec::new());
    super::search_project(project, syntax, &query, cancel, &|file| found.lock().unwrap().push(file.path))?;
    let mut skip: std::collections::HashMap<_, _> = listed.into_iter().map(|t| (t.path, t.skip)).collect();
    let mut paths = found.into_inner().unwrap();
    paths.sort();
    Ok(paths.into_iter().map(|path| ReplaceTarget { skip: skip.remove(&path).flatten(), path, only: None }).collect())
}

/// Before / after text of `path` for Replace › Preview (unsaved buffer included).
#[command(trust = trusted)]
pub async fn replace_preview(
    host: &Host,
    window: &str,
    query: SearchQuery,
    replacement: String,
    preserve_case: bool,
    path: PathBuf,
    only: Option<Vec<Pos>>,
) -> IdeResult<ReplacePreview> {
    let project = host.project(window)?;
    tokio::task::spawn_blocking(move || {
        let text = project.text_of(&path)?;
        ide_search::preview(&text, &query, &replacement, preserve_case, only.as_deref())
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()))?
}

/// Validates a query (e.g. regex syntax) while the user types.
#[command(trust = always)]
pub fn search_validate(query: SearchQuery) -> IdeResult<()> {
    ide_search::validate_query(&query)
}

ide_command::domain!(search_commands: replace_in_files, replace_preview, search_validate);
