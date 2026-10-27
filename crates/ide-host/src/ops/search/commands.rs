#[allow(unused_imports)]
use super::*;
use crate::Host;
use crate::ops::Channel;
use crate::rpc::Dispatcher;
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
                if transient {
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
/// editor buffers are replaced in place and left unsaved; files that were not
/// open are opened transiently, saved and closed.
#[allow(clippy::too_many_arguments)]
pub async fn replace_in_files(
    host: &Host,
    window: &str,
    request: RequestId,
    query: SearchQuery,
    replacement: String,
    preserve_case: bool,
    targets: Vec<ReplaceTarget>,
    on_event: Channel<ReplaceEvent>,
) -> IdeResult<()> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let events = on_event.clone();
    let summary = tokio::task::spawn_blocking(move || {
        let host = DocumentsHost(&project.documents);
        ide_search::replace_files(&host, &query, &replacement, preserve_case, &targets, &cancel, &|e| {
            let _ = events.send(e);
        })
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()));
    host.end_request(request);
    let summary = summary??;
    let _ = on_event.send(ReplaceEvent::Done { summary });
    Ok(())
}

/// Before / after text of `path` for Replace › Preview (unsaved buffer included).
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
pub fn search_validate(_host: &Host, _window: &str, query: SearchQuery) -> IdeResult<()> {
    ide_search::validate_query(&query)
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("replace_in_files", |c| async move {
        replace_in_files(
            &c.host,
            &c.window,
            c.arg("request")?,
            c.arg("query")?,
            c.arg("replacement")?,
            c.arg("preserveCase")?,
            c.arg("targets")?,
            c.sender("onEvent")?,
        )
        .await
    });
    d.add("replace_preview", |c| async move {
        replace_preview(
            &c.host,
            &c.window,
            c.arg("query")?,
            c.arg("replacement")?,
            c.arg("preserveCase")?,
            c.arg("path")?,
            c.arg("only")?,
        )
        .await
    });
    d.add("search_validate", |c| async move { search_validate(&c.host, &c.window, c.arg("query")?) });
}
