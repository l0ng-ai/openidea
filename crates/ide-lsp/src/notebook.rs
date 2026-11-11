//! Jupyter notebooks on servers that sync them with LSP 3.17 `notebookDocument/*` (basedpyright,
//! Ruff). Each code cell is a document of its own, `vscode-notebook-cell:<notebook path>#<cell id>`,
//! kept in `docs` under a [`DocId`]: completion, hover and the other requests address a cell like
//! any open file. Only opening, changing and closing go through the notebook methods; a change in
//! the cells' order closes and reopens the notebook.

use crate::server::{Running, Server};
use crate::text::DocText;
use crate::{Attached, DocState, LspManager, uri};
use ide_core::{DocId, LanguageId, ServerId};
use lsp_types as lsp;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Serialize;
use serde_json::{Value, json};
use specta::Type;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;

const CELL_SCHEME: &str = "vscode-notebook-cell";
const NOTEBOOK_TYPE: &str = "jupyter-notebook";
/// `NotebookCellKind.Code`.
const CODE_CELL: u32 = 2;
/// Escaped in a cell id: nbformat ids are `[a-zA-Z0-9-_]`, older notebooks may have others.
const FRAGMENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_');

/// A code cell as the notebook holds it.
pub struct NotebookCell {
    pub id: String,
    pub source: String,
}

/// The document the language servers know a code cell by.
#[derive(Clone, Debug, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotebookCellDoc {
    pub cell: String,
    pub doc: DocId,
    /// Also the `path` of the cell's diagnostics and of locations in it.
    pub uri: String,
}

pub(crate) struct NotebookState {
    uri: lsp::Uri,
    language: LanguageId,
    version: i32,
    /// Code cells in notebook order.
    cells: Vec<(String, DocId)>,
    servers: Vec<Arc<Server>>,
    /// Servers it is open on, by instance generation.
    opened: Vec<(ServerId, u64)>,
}

/// The URI of cell `cell` of the notebook at `path`: the notebook's `file:` URI with the cell
/// scheme and the cell id as fragment (as VS Code names cells; basedpyright expects the scheme).
pub fn cell_uri(path: &Path, cell: &str) -> String {
    let file = uri::path_to_uri_string(path);
    let rest = file.strip_prefix("file://").unwrap_or(&file);
    // `file:///C:/a` → `…:/C:/a`; a share (`file://server/s/a`) keeps its authority.
    let authority = if rest.starts_with('/') { "" } else { "//" };
    format!("{CELL_SCHEME}:{authority}{rest}#{}", utf8_percent_encode(cell, FRAGMENT))
}

pub(crate) fn is_cell_uri(uri: &str) -> bool {
    uri.strip_prefix(CELL_SCHEME).is_some_and(|rest| rest.starts_with(':'))
}

fn parse_uri(s: &str) -> Option<lsp::Uri> {
    lsp::Uri::from_str(s).inspect_err(|e| tracing::debug!("not a valid URI {s}: {e}")).ok()
}

impl NotebookState {
    fn opened_on(&self, server: ServerId, generation: u64) -> bool {
        self.opened.contains(&(server, generation))
    }

    /// The servers it is open on whose instance is still the one it was opened on.
    fn open_targets(&self) -> Vec<(Arc<Server>, Running)> {
        self.servers
            .iter()
            .filter_map(|s| {
                let run = s.running()?;
                self.opened_on(s.id, run.generation).then(|| (s.clone(), run))
            })
            .collect()
    }
}

impl LspManager {
    /// Opens the notebook at `path` on its language's servers that sync notebooks, or brings
    /// them up to date with `cells` (its code cells, in order).
    pub fn sync_notebook(&self, path: &Path, language: &LanguageId, cells: &[NotebookCell]) {
        let mut notebooks = self.notebooks.lock();
        let mut changed = Vec::new();
        let start = match notebooks.get_mut(path) {
            None => {
                let Some(notebook_uri) = parse_uri(&uri::path_to_uri_string(path)) else { return };
                let servers = self.servers_for(language, path);
                let mut state = NotebookState {
                    uri: notebook_uri,
                    language: language.clone(),
                    version: 1,
                    cells: Vec::new(),
                    servers: servers.clone(),
                    opened: Vec::new(),
                };
                self.set_cells(path, &mut state, cells);
                self.open_notebook(&mut state, None);
                notebooks.insert(path.to_owned(), state);
                servers
            }
            Some(state) => {
                let same_cells =
                    state.cells.len() == cells.len() && state.cells.iter().zip(cells).all(|((id, _), c)| *id == c.id);
                if same_cells {
                    changed = self.change_cells(state, cells);
                } else {
                    self.close_notebook_on_servers(state);
                    state.version += 1;
                    self.set_cells(path, state, cells);
                    self.open_notebook(state, None);
                }
                Vec::new()
            }
        };
        drop(notebooks);
        for server in &start {
            self.ensure_started(server);
        }
        for doc in changed {
            self.schedule_pull(doc, None, crate::pull::AFTER_EDIT);
        }
    }

    /// Closes the notebook at `path` on its servers and forgets its cells.
    pub fn close_notebook(&self, path: &Path) {
        let Some(mut state) = self.notebooks.lock().remove(path) else { return };
        self.close_notebook_on_servers(&mut state);
        let removed: Vec<DocId> = state.cells.iter().map(|(_, doc)| *doc).collect();
        self.remove_cells(&state.servers, &removed);
    }

    /// The documents of the notebook's code cells, in notebook order; empty when it isn't open.
    pub fn notebook_cells(&self, path: &Path) -> Vec<NotebookCellDoc> {
        let notebooks = self.notebooks.lock();
        let Some(state) = notebooks.get(path) else { return Vec::new() };
        let docs = self.docs.lock();
        state
            .cells
            .iter()
            .filter_map(|(cell, doc)| {
                Some(NotebookCellDoc { cell: cell.clone(), doc: *doc, uri: docs.get(doc)?.uri.as_str().to_owned() })
            })
            .collect()
    }

    /// Opens the notebooks of `server`'s language on its instance that just became ready.
    pub(crate) fn reopen_notebooks(&self, server: &Arc<Server>, run: &Running) {
        let mut pull = Vec::new();
        {
            let mut notebooks = self.notebooks.lock();
            for state in notebooks.values_mut() {
                if state.servers.iter().any(|s| s.id == server.id) && !state.opened_on(server.id, run.generation) {
                    self.open_notebook(state, Some(server));
                    pull.extend(state.cells.iter().map(|(_, doc)| *doc));
                }
            }
        }
        for doc in pull {
            self.schedule_pull(doc, Some(server), std::time::Duration::ZERO);
        }
    }

    /// Adds servers of the notebooks' languages that were not wanted when they opened (a
    /// fallback for a missing server, one enabled in settings) and returns them to be started.
    pub(crate) fn attach_notebook_servers(&self) -> Vec<Arc<Server>> {
        let mut start = Vec::new();
        let mut notebooks = self.notebooks.lock();
        for (path, state) in notebooks.iter_mut() {
            let added: Vec<Arc<Server>> = self
                .servers_for(&state.language, path)
                .into_iter()
                .filter(|s| !state.servers.iter().any(|known| known.id == s.id))
                .collect();
            if added.is_empty() {
                continue;
            }
            {
                let mut docs = self.docs.lock();
                for (_, doc) in &state.cells {
                    if let Some(d) = docs.get_mut(doc) {
                        d.servers.extend(added.iter().map(|s| Attached { server: s.clone(), opened_gen: None }));
                    }
                }
            }
            state.servers.extend(added.iter().cloned());
            for server in &added {
                self.open_notebook(state, Some(server));
            }
            start.extend(added);
        }
        start
    }

    /// Replaces the cell documents with `cells`: kept cells keep their [`DocId`].
    fn set_cells(&self, path: &Path, state: &mut NotebookState, cells: &[NotebookCell]) {
        let mut docs = self.docs.lock();
        let previous = std::mem::take(&mut state.cells);
        for cell in cells {
            let kept = previous.iter().find(|(id, _)| *id == cell.id).map(|(_, doc)| *doc);
            if let Some(doc) = kept
                && let Some(d) = docs.get_mut(&doc)
            {
                if d.text.as_str() != cell.source {
                    Arc::make_mut(&mut d.text).set(&cell.source);
                }
                d.version += 1;
                state.cells.push((cell.id.clone(), doc));
                continue;
            }
            let uri_string = cell_uri(path, &cell.id);
            let Some(cell_uri) = parse_uri(&uri_string) else { continue };
            let doc = DocId::next();
            let key = PathBuf::from(&uri_string);
            docs.insert(
                doc,
                DocState {
                    canonical: key.clone(),
                    path: key,
                    uri: cell_uri,
                    language: state.language.clone(),
                    version: 1,
                    text: Arc::new(DocText::new(&cell.source)),
                    servers: state.servers.iter().map(|s| Attached { server: s.clone(), opened_gen: None }).collect(),
                    compose_detected: false,
                    notebook: Some(path.to_owned()),
                },
            );
            state.cells.push((cell.id.clone(), doc));
        }
        drop(docs);
        let removed: Vec<DocId> = previous
            .into_iter()
            .filter(|(_, doc)| !state.cells.iter().any(|(_, d)| d == doc))
            .map(|(_, d)| d)
            .collect();
        self.remove_cells(&state.servers, &removed);
    }

    /// Sends the cells whose text differs from `cells` as one change; returns their documents.
    fn change_cells(&self, state: &mut NotebookState, cells: &[NotebookCell]) -> Vec<DocId> {
        let mut docs = self.docs.lock();
        let mut changed = Vec::new();
        let mut content = Vec::new();
        for ((_, doc), cell) in state.cells.iter().zip(cells) {
            let Some(d) = docs.get_mut(doc) else { continue };
            if d.text.as_str() == cell.source {
                continue;
            }
            Arc::make_mut(&mut d.text).set(&cell.source);
            d.version += 1;
            content.push(json!({
                "document": { "uri": d.uri, "version": d.version },
                "changes": [{ "text": cell.source }],
            }));
            changed.push(*doc);
        }
        drop(docs);
        if content.is_empty() {
            return changed;
        }
        state.version += 1;
        let params = json!({
            "notebookDocument": { "uri": state.uri, "version": state.version },
            "change": { "cells": { "textContent": content } },
        });
        for (server, run) in state.open_targets() {
            if let Err(e) = run.peer.notify("notebookDocument/didChange", params.clone()) {
                tracing::debug!("{}: notebookDocument/didChange: {e}", server.name);
            }
        }
        changed
    }

    /// Opens the notebook on its running servers that sync notebooks (`only`: on that one).
    fn open_notebook(&self, state: &mut NotebookState, only: Option<&Arc<Server>>) {
        let mut docs = self.docs.lock();
        let mut cells = Vec::new();
        let mut texts = Vec::new();
        for (_, doc) in &state.cells {
            let Some(d) = docs.get(doc) else { continue };
            cells.push(json!({ "kind": CODE_CELL, "document": d.uri }));
            texts.push(json!({
                "uri": d.uri,
                "languageId": d.language.as_str(),
                "version": d.version,
                "text": d.text.as_str(),
            }));
        }
        let params = json!({
            "notebookDocument": { "uri": state.uri, "notebookType": NOTEBOOK_TYPE, "version": state.version, "cells": cells },
            "cellTextDocuments": texts,
        });
        let servers: Vec<Arc<Server>> =
            state.servers.iter().filter(|s| only.is_none_or(|o| o.id == s.id)).cloned().collect();
        for server in servers {
            let Some(run) = server.running() else { continue };
            if state.opened_on(server.id, run.generation) || !run.caps.read().syncs_notebooks(state.language.as_str()) {
                continue;
            }
            if let Err(e) = run.peer.notify("notebookDocument/didOpen", params.clone()) {
                tracing::debug!("{}: notebookDocument/didOpen: {e}", server.name);
                continue;
            }
            state.opened.retain(|(id, _)| *id != server.id);
            state.opened.push((server.id, run.generation));
            for (_, doc) in &state.cells {
                if let Some(a) = docs.get_mut(doc).and_then(|d| d.servers.iter_mut().find(|a| a.server.id == server.id))
                {
                    a.opened_gen = Some(run.generation);
                }
            }
        }
    }

    fn close_notebook_on_servers(&self, state: &mut NotebookState) {
        let cells: Vec<Value> = {
            let docs = self.docs.lock();
            state.cells.iter().filter_map(|(_, doc)| docs.get(doc)).map(|d| json!({ "uri": d.uri })).collect()
        };
        let params = json!({ "notebookDocument": { "uri": state.uri }, "cellTextDocuments": cells });
        for (server, run) in state.open_targets() {
            if let Err(e) = run.peer.notify("notebookDocument/didClose", params.clone()) {
                tracing::debug!("{}: notebookDocument/didClose: {e}", server.name);
            }
        }
        state.opened.clear();
        let mut docs = self.docs.lock();
        for (_, doc) in &state.cells {
            if let Some(d) = docs.get_mut(doc) {
                d.servers.iter_mut().for_each(|a| a.opened_gen = None);
            }
        }
    }

    /// Forgets cell documents and clears what their servers reported about them: a server need
    /// not clear the diagnostics of a cell that left the notebook.
    fn remove_cells(&self, servers: &[Arc<Server>], removed: &[DocId]) {
        let gone: Vec<DocState> = {
            let mut docs = self.docs.lock();
            removed.iter().filter_map(|doc| docs.remove(doc)).collect()
        };
        for d in gone {
            for server in servers {
                let run = server.running();
                self.forget_pulled(server, &d.path, run.as_ref());
                let enc = run.as_ref().map(|r| r.caps.read().encoding).unwrap_or_default();
                let shown = server.set_diagnostics(d.path.clone(), Vec::new());
                self.emit_diagnostics(server, d.path.clone(), shown, enc);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cell_uris_name_the_notebook_file_and_the_cell() {
        let root = if cfg!(windows) { PathBuf::from(r"C:\work\my nb") } else { PathBuf::from("/work/my nb") };
        let expected = if cfg!(windows) {
            "vscode-notebook-cell:/C:/work/my%20nb/a.ipynb#f3-x_1%2E"
        } else {
            "vscode-notebook-cell:/work/my%20nb/a.ipynb#f3-x_1%2E"
        };
        let uri = cell_uri(&root.join("a.ipynb"), "f3-x_1.");
        assert_eq!(uri, expected);
        assert!(is_cell_uri(&uri) && parse_uri(&uri).is_some());
        assert!(!is_cell_uri("file:///a.ipynb") && !is_cell_uri("vscode-notebook-cellx:/a"));
    }
}
