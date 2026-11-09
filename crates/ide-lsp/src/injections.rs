//! Masked file documents for plugin-provided embedded languages.
use crate::{
    LspManager, convert,
    server::Server,
    text::Encoding,
    types::{Command, CompletionItem},
};
use ide_core::{DocId, FileEdit, IdeError, IdeResult, LanguageId, Location, Pos, Range, WorkspaceEdit};
use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

pub const MAX_INJECTED_DOCUMENT_BYTES: usize = 2 << 20;
const MAX_DOCUMENTS: usize = 32;
const MARKER: &str = ".openidea-injected-";
const ORIGIN: &str = "$openideaInjection";
pub(super) const COMMAND: &str = "$openideaInjectedCommand";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InjectedRange {
    pub range: Range,
    pub language: LanguageId,
}

/// Runs on a blocking worker, with the host's unsaved snapshot.
pub type InjectionProvider = dyn Fn(&Path, &LanguageId, u32, &str) -> Vec<InjectedRange> + Send + Sync;

#[derive(Clone)]
struct Document {
    host: DocId,
    host_path: PathBuf,
    version: u32,
    path: PathBuf,
    injection: InjectedRange,
    active: bool,
}

#[derive(Default)]
pub(super) struct State {
    pub gate: Mutex<()>,
    provider: RwLock<Option<Arc<InjectionProvider>>>,
    documents: RwLock<HashMap<DocId, Document>>,
    refreshed: Mutex<HashMap<DocId, u32>>,
    refresh: tokio::sync::Mutex<()>,
    generation: AtomicU64,
}

fn reserved(path: &Path) -> bool {
    path.file_name().is_some_and(|s| {
        let name = s.to_string_lossy();
        name.rsplit_once(MARKER)
            .and_then(|(_, suffix)| suffix.split_once('.'))
            .is_some_and(|(id, _)| !id.is_empty() && id.bytes().all(|c| c.is_ascii_digit()))
    }) && !path.exists()
}

fn contains(range: Range, pos: Pos) -> bool {
    range.start <= pos && pos < range.end
}

fn clip(bounds: Range, range: Range) -> Option<Range> {
    if range.start > range.end {
        return None;
    }
    if range.is_empty() {
        return contains(bounds, range.start).then_some(range);
    }
    let start = bounds.start.max(range.start);
    let end = bounds.end.min(range.end);
    (start < end).then_some(Range::new(start, end))
}

fn confined(bounds: Range, range: Range) -> bool {
    range.start <= range.end && bounds.start <= range.start && range.end <= bounds.end
}

fn mask(text: &str, range: Range) -> String {
    let mut at = Pos::default();
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if contains(range, at) || matches!(c, '\n' | '\r') {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n(' ', c.len_utf16()));
        }
        if c == '\n' {
            at.line += 1;
            at.col = 0;
        } else if c != '\r' {
            at.col += c.len_utf16() as u32;
        }
    }
    out
}

impl LspManager {
    pub fn set_injection_provider(&self, provider: Arc<InjectionProvider>) {
        *self.injections.provider.write() = Some(provider);
    }

    pub(super) fn schedule_injections(&self, doc: DocId) {
        if self.injections.provider.read().is_none() || self.is_injected_doc(doc) {
            return;
        }
        let Some(me) = self.me.upgrade() else { return };
        let Ok(snap) = self.snapshot(doc) else { return };
        self.runtime.spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            if me.snapshot(doc).is_ok_and(|s| s.version == snap.version) {
                let _ = me.refresh_injections(doc).await;
            }
        });
    }

    /// Refresh on demand as well as after edits: point requests need not wait for the debounce.
    pub async fn refresh_injections(&self, doc: DocId) -> IdeResult<()> {
        let _refresh = self.injections.refresh.lock().await;
        let generation = self.injections.generation.load(Ordering::Acquire);
        let Ok(snap) = self.snapshot(doc) else { return Ok(()) };
        if self.is_injected_doc(doc) || self.injections.refreshed.lock().get(&doc) == Some(&(snap.version as u32)) {
            return Ok(());
        }
        let provider = self.injections.provider.read().clone();
        let ranges = if snap.text.as_str().len() <= MAX_INJECTED_DOCUMENT_BYTES && !uri_is_virtual(&snap.path) {
            if let Some(provider) = provider {
                let (path, language, text, version) = (snap.path, snap.language, snap.text, snap.version);
                tokio::task::spawn_blocking(move || provider(&path, &language, version as u32, text.as_str()))
                    .await
                    .map_err(|e| IdeError::unavailable(e.to_string()))?
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };
        if let Some(me) = self.me.upgrade() {
            tokio::task::spawn_blocking(move || me.set_injections_at(doc, snap.version as u32, ranges, generation))
                .await
                .map_err(|e| IdeError::unavailable(e.to_string()))?;
        }
        if self.injection_generation() != generation || !self.snapshot(doc).is_ok_and(|s| s.version == snap.version) {
            return Err(IdeError::cancelled());
        }
        Ok(())
    }

    /// Revision of plugin providers used to reject an obsolete refresh.
    pub fn injection_generation(&self) -> u64 {
        self.injections.generation.load(Ordering::Acquire)
    }

    pub fn set_injections(&self, host: DocId, version: u32, ranges: Vec<InjectedRange>) {
        self.set_injections_at(host, version, ranges, self.injection_generation());
    }

    pub fn set_injections_at(&self, host: DocId, version: u32, mut ranges: Vec<InjectedRange>, generation: u64) {
        let _gate = self.injections.gate.lock();
        if generation != self.injection_generation() {
            return;
        }
        let Ok(snap) = self.snapshot(host) else { return };
        if snap.version as u32 != version || self.is_injected_doc(host) {
            return;
        }
        if snap.text.as_str().len() > MAX_INJECTED_DOCUMENT_BYTES {
            ranges.clear();
        }
        ranges.sort_by_key(|r| r.range);
        let mut end = Pos::default();
        ranges.retain(|i| {
            let r = i.range;
            let valid_pos = |p: Pos| {
                (p.line as usize) < snap.text.line_count()
                    && snap.text.lsp_to_ide(Encoding::Utf8, snap.text.ide_to_lsp(Encoding::Utf8, p)) == p
            };
            if r.start >= r.end
                || r.start < end
                || !valid_pos(r.start)
                || !valid_pos(r.end)
                || i.language == snap.language
                || self.language_servers(&i.language).is_empty()
            {
                return false;
            }
            end = r.end;
            true
        });
        ranges.truncate(MAX_DOCUMENTS);
        let mut old: Vec<_> = self
            .injections
            .documents
            .read()
            .iter()
            .filter(|(_, d)| d.host == host)
            .map(|(id, d)| (*id, d.clone()))
            .collect();
        old.sort_by_key(|(_, d)| d.injection.range);
        let mut retained = Vec::new();
        for (slot, injection) in ranges.into_iter().enumerate() {
            let existing =
                old.iter().position(|(id, d)| !retained.contains(id) && d.injection == injection).or_else(|| {
                    old.get(slot)
                        .filter(|(id, d)| !retained.contains(id) && d.injection.language == injection.language)
                        .map(|_| slot)
                });
            let text = mask(snap.text.as_str(), injection.range);
            if let Some(index) = existing {
                let (id, mut d) = old[index].clone();
                if d.injection != injection {
                    self.clear_injected_diagnostics(&d);
                }
                d.version = version;
                d.injection = injection;
                d.active = true;
                self.injections.documents.write().insert(id, d);
                self.sync_injected(id, &text);
                retained.push(id);
            } else {
                let Some(cfg) = self.languages.get(&injection.language) else { continue };
                let ext = cfg
                    .extensions
                    .iter()
                    .find(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric()))
                    .map(String::as_str)
                    .unwrap_or("txt");
                let mut id = DocId::next();
                let path = loop {
                    let path = snap.path.with_file_name(format!(
                        ".{}{MARKER}{}.{}",
                        snap.path.file_name().unwrap_or_default().to_string_lossy(),
                        id.0,
                        ext
                    ));
                    if !path.exists() {
                        break path;
                    }
                    id = DocId::next();
                };
                self.injections.documents.write().insert(
                    id,
                    Document {
                        host,
                        host_path: snap.path.clone(),
                        version,
                        path: path.clone(),
                        injection: injection.clone(),
                        active: true,
                    },
                );
                let servers = self.servers_for(&injection.language, &path);
                self.attach(
                    id,
                    path.clone(),
                    crate::uri::path_to_uri(&path),
                    &injection.language,
                    version,
                    &text,
                    servers,
                );
                retained.push(id);
            }
        }
        for (id, d) in old {
            if !retained.contains(&id) {
                self.injections.documents.write().remove(&id);
                self.close_document(id);
                self.clear_injected_diagnostics(&d);
            }
        }
        self.injections.refreshed.lock().insert(host, version);
    }

    /// Plugin enable/disable/reload changes the ranges even without a buffer edit.
    pub fn injection_providers_changed(&self) {
        let _gate = self.injections.gate.lock();
        self.injections.generation.fetch_add(1, Ordering::AcqRel);
        self.injections.refreshed.lock().clear();
        let hosts: Vec<_> = self.docs.lock().keys().copied().collect();
        for doc in hosts {
            if !self.is_injected_doc(doc) {
                self.close_injections(doc);
                self.schedule_injections(doc);
            }
        }
    }

    pub(super) fn map_injected_event(&self, mut event: ide_core::IdeEvent) -> Option<ide_core::IdeEvent> {
        if let ide_core::IdeEvent::Diagnostics { path, .. } = &mut event
            && reserved(path)
        {
            let docs = self.injections.documents.read();
            let d = docs.values().find(|d| d.path == path.as_ref())?;
            *path = d.host_path.clone().into();
        }
        Some(event)
    }

    pub(super) fn injected_request_stamp(&self, params: &Value) -> Option<(DocId, i32)> {
        let path = crate::uri::uri_to_path(params.pointer("/textDocument/uri")?.as_str()?)?;
        if !reserved(&path) {
            return None;
        }
        self.docs.lock().iter().find(|(_, d)| d.path == path).map(|(id, d)| (*id, d.version))
    }

    pub(super) fn check_injected_request(&self, doc: DocId, version: i32) -> IdeResult<()> {
        let active = self.injections.documents.read().get(&doc).is_some_and(|d| d.active);
        if !active || !self.snapshot(doc).is_ok_and(|s| s.version == version) {
            return Err(IdeError::cancelled());
        }
        Ok(())
    }

    pub(super) fn accepts_injected_diagnostics(&self, path: &Path, version: Option<i32>) -> bool {
        if !reserved(path) {
            return true;
        }
        let docs = self.injections.documents.read();
        docs.iter().any(|(id, d)| {
            d.active && d.path == path && self.snapshot(*id).is_ok_and(|s| version.is_none_or(|v| s.version == v))
        })
    }

    pub fn injected_document(&self, host: DocId, pos: Pos) -> DocId {
        let version = self.snapshot(host).ok().map(|s| s.version as u32);
        self.injections
            .documents
            .read()
            .iter()
            .find(|(_, d)| d.host == host && d.active && Some(d.version) == version && contains(d.injection.range, pos))
            .map_or(host, |(id, _)| *id)
    }

    pub fn injected_request_range(&self, doc: DocId, range: Range) -> Range {
        self.clip_injected_range(doc, range).unwrap_or(range)
    }

    pub(super) fn is_injected_doc(&self, doc: DocId) -> bool {
        self.injections.documents.read().contains_key(&doc)
    }

    pub(super) fn clip_injected_range(&self, doc: DocId, range: Range) -> Option<Range> {
        match self.injections.documents.read().get(&doc) {
            Some(d) if d.active => clip(d.injection.range, range),
            Some(_) => None,
            None => Some(range),
        }
    }

    fn sync_injected(&self, id: DocId, text: &str) {
        let mut docs = self.docs.lock();
        let Some(d) = docs.get_mut(&id) else { return };
        if d.text.as_str() == text {
            return;
        }
        d.version += 1;
        Arc::make_mut(&mut d.text).set(text);
        for a in &d.servers {
            let Some(run) = a.server.running() else { continue };
            if a.opened_gen != Some(run.generation) || run.caps.read().sync == crate::SyncKind::None {
                continue;
            }
            let _ = run.peer.notify(
                "textDocument/didChange",
                json!({
                    "textDocument": { "uri": d.uri, "version": d.version }, "contentChanges": [{ "text": text }]
                }),
            );
        }
        drop(docs);
        self.schedule_pull(id, None, Duration::ZERO);
    }

    pub(super) fn invalidate_injections(&self, host: DocId) {
        self.injections.refreshed.lock().remove(&host);
        let old: Vec<_> = self
            .injections
            .documents
            .read()
            .iter()
            .filter(|(_, d)| d.host == host)
            .map(|(id, d)| (*id, d.clone()))
            .collect();
        if old.is_empty() {
            return;
        }
        for (id, d) in old {
            if let Some(d) = self.injections.documents.write().get_mut(&id) {
                d.active = false;
            }
            self.clear_injected_diagnostics(&d);
        }
    }

    pub(super) fn close_injections(&self, host: DocId) {
        self.injections.refreshed.lock().remove(&host);
        let old: Vec<_> = self
            .injections
            .documents
            .read()
            .iter()
            .filter(|(_, d)| d.host == host)
            .map(|(id, d)| (*id, d.clone()))
            .collect();
        for (id, d) in old {
            self.injections.documents.write().remove(&id);
            self.close_document(id);
            self.clear_injected_diagnostics(&d);
        }
    }

    pub(super) fn map_injected_location(&self, mut loc: Location) -> Option<Location> {
        let docs = self.injections.documents.read();
        if let Some(d) = docs.values().find(|d| d.path == loc.path.as_ref()) {
            if !d.active {
                return None;
            }
            loc.range = clip(d.injection.range, loc.range)?;
            loc.path = d.host_path.clone().into();
            loc.uri = None;
            Some(loc)
        } else {
            (!reserved(&loc.path)).then_some(loc)
        }
    }

    pub(super) fn map_injected_edit(&self, edit: &mut WorkspaceEdit) {
        let docs = self.injections.documents.read();
        edit.files.retain_mut(|f| match f {
            FileEdit::Edit { path, edits, version } => {
                if let Some(d) = docs.values().find(|d| d.path == path.as_ref()) {
                    if !d.active {
                        return false;
                    }
                    // Clipping replacements changes their meaning; discard edits crossing a boundary.
                    edits.retain(|e| confined(d.injection.range, e.range));
                    *path = d.host_path.clone().into();
                    *version = Some(d.version as i32);
                    !edits.is_empty()
                } else {
                    !reserved(path)
                }
            }
            FileEdit::Create { path, .. } | FileEdit::Delete { path, .. } => {
                !reserved(path) && !docs.values().any(|d| d.path == path.as_ref())
            }
            FileEdit::Rename { from, to } => {
                !reserved(from)
                    && !reserved(to)
                    && !docs.values().any(|d| d.path == from.as_ref() || d.path == to.as_ref())
            }
        });
    }

    pub(super) fn provides_injected_command(&self, host: DocId, server: Option<ide_core::ServerId>) -> bool {
        let ids: Vec<_> = self
            .injections
            .documents
            .read()
            .iter()
            .filter(|(id, d)| d.host == host || **id == host)
            .map(|(id, _)| *id)
            .collect();
        let docs = self.docs.lock();
        ids.iter()
            .any(|id| docs.get(id).is_some_and(|d| d.servers.iter().any(|a| server.is_none_or(|s| a.server.id == s))))
    }

    pub(super) fn tag_injected_command(&self, doc: DocId, server: ide_core::ServerId, command: &mut Option<Command>) {
        let Some(original) = command.take() else { return };
        if self.is_injected_doc(doc) {
            let mut data = Some(serde_json::to_value(&original).expect("command is JSON"));
            self.tag_injected_origin(doc, &mut data);
            *command = Some(Command {
                title: original.title,
                command: COMMAND.into(),
                arguments: vec![json!({ "origin": data, "server": server })],
            });
        } else {
            *command = Some(original);
        }
    }

    pub(super) fn injected_command(
        &self,
        host: DocId,
        command: Command,
    ) -> IdeResult<(DocId, Command, Option<ide_core::ServerId>)> {
        if command.command != COMMAND {
            return Ok((host, command, None));
        }
        let payload = command.arguments.first().ok_or_else(IdeError::cancelled)?;
        let origin = payload.pointer("/origin/$openideaInjection").ok_or_else(IdeError::cancelled)?;
        let doc =
            origin["doc"].as_u64().and_then(|id| u32::try_from(id).ok()).map(DocId).ok_or_else(IdeError::cancelled)?;
        // Acceptance may already have edited the host. Keep the server/document identity;
        // execute refreshes its mask first, and cannot revive a disappeared injection.
        if !self.injections.documents.read().get(&doc).is_some_and(|d| d.host == host || doc == host) {
            return Err(IdeError::cancelled());
        }
        let command = serde_json::from_value(origin["data"].clone()).map_err(|_| IdeError::cancelled())?;
        let server =
            payload["server"].as_u64().map(|id| ide_core::ServerId(id as u32)).ok_or_else(IdeError::cancelled)?;
        Ok((doc, command, Some(server)))
    }

    pub(super) fn tag_injected_origin(&self, doc: DocId, data: &mut Option<Value>) {
        if let Some(d) = self.injections.documents.read().get(&doc) {
            *data = Some(json!({ ORIGIN: { "doc": doc, "version": d.version, "data": data.take() } }));
        }
    }

    pub(super) fn resolve_injected_origin(&self, host: DocId, data: &mut Option<Value>) -> IdeResult<DocId> {
        let Some(origin) = data.as_ref().and_then(|v| v.get(ORIGIN)) else { return Ok(host) };
        let doc = origin["doc"].as_u64().map(|id| DocId(id as u32)).ok_or_else(IdeError::cancelled)?;
        let docs = self.injections.documents.read();
        let d = docs
            .get(&doc)
            .filter(|d| {
                (d.host == host || doc == host) && d.active && origin["version"].as_u64() == Some(d.version.into())
            })
            .ok_or_else(IdeError::cancelled)?;
        if self.snapshot(d.host)?.version as u32 != d.version {
            return Err(IdeError::cancelled());
        }
        *data = origin.get("data").filter(|v| !v.is_null()).cloned();
        Ok(doc)
    }

    pub(super) fn bound_completion(&self, doc: DocId, item: &mut CompletionItem) -> bool {
        let docs = self.injections.documents.read();
        let Some(d) = docs.get(&doc) else { return !self.snapshot(doc).is_ok_and(|s| reserved(&s.path)) };
        if !d.active {
            return false;
        }
        for r in [&mut item.replace_range, &mut item.replace_range_tab].into_iter().flatten() {
            let Some(clipped) = clip(d.injection.range, *r) else { return false };
            *r = clipped;
        }
        item.additional_edits.retain(|e| confined(d.injection.range, e.range));
        drop(docs);
        self.tag_injected_command(doc, item.server, &mut item.command);
        self.tag_injected_origin(doc, &mut item.data);
        true
    }

    fn clear_injected_diagnostics(&self, d: &Document) {
        let servers = self.servers.lock().clone();
        for server in servers {
            server.set_diagnostics(d.path.clone(), Vec::new());
            server.clear_pulled(&d.path);
            let items = server.diagnostics_for(&d.host_path);
            let enc = server.running().map(|r| r.caps.read().encoding).unwrap_or_default();
            self.emit_diagnostics(&server, d.host_path.clone(), items, enc);
        }
    }

    /// One event per host/source includes every fragment and the server's native host diagnostics.
    pub(super) fn injected_diagnostics(
        &self,
        server: &Server,
        path: &Path,
        enc: Encoding,
        native: Vec<lsp_types::Diagnostic>,
    ) -> Option<(PathBuf, Vec<ide_core::Diagnostic>)> {
        let docs: Vec<_> = self.injections.documents.read().values().cloned().collect();
        let host_path = if let Some(d) = docs.iter().find(|d| d.path == path) {
            d.host_path.clone()
        } else if reserved(path) {
            return None;
        } else {
            path.to_owned()
        };
        let conv = self.conv(enc);
        let native = if path == host_path { native } else { server.diagnostics_for(&host_path) };
        let mut items: Vec<_> =
            native.into_iter().map(|d| convert::diagnostic(&conv, &host_path, d, &server.name)).collect();
        for d in docs.iter().filter(|d| d.active && d.host_path == host_path) {
            items.extend(server.diagnostics_for(&d.path).into_iter().filter_map(|diag| {
                let mut diag = convert::diagnostic(&conv, &d.path, diag, &server.name);
                if !confined(d.injection.range, diag.range)
                    || (diag.range.is_empty() && !contains(d.injection.range, diag.range.start))
                {
                    return None;
                }
                diag.source = Some(server.name.clone());
                Some(diag)
            }));
        }
        (!reserved(&host_path)).then_some((host_path, items))
    }
}

fn uri_is_virtual(path: &Path) -> bool {
    ide_core::is_virtual_uri(&path.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Missing;
    impl crate::Launcher for Missing {
        fn launch(
            &self,
            _: &ide_language::LanguageServerConfig,
            _: &Path,
            _: Arc<dyn ide_jsonrpc::Handler>,
            _: Box<dyn Fn(String) + Send + Sync>,
        ) -> Result<ide_jsonrpc::Peer, crate::LaunchError> {
            Err(crate::LaunchError::Missing)
        }
    }

    fn manager() -> (Arc<LspManager>, tempfile::TempDir, Arc<Mutex<Vec<ide_core::IdeEvent>>>) {
        let root = tempfile::tempdir().unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let output = events.clone();
        let mgr = LspManager::with_launcher(
            root.path().to_path_buf(),
            Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            Arc::new(move |e| output.lock().push(e)),
            Arc::new(Missing),
        );
        (mgr, root, events)
    }

    fn injection(a: u32, b: u32) -> InjectedRange {
        InjectedRange { range: Range::new(Pos::new(0, a), Pos::new(0, b)), language: LanguageId::new("sql") }
    }

    #[test]
    fn routing_mapping_edits_and_limits() {
        let (mgr, root, _) = manager();
        let host = DocId::next();
        let path = root.path().join("a.java");
        mgr.did_open(host, &path, &LanguageId::plain_text(), 1, "😀 select tail");
        mgr.set_injections(host, 1, vec![injection(3, 9)]);
        let embedded = mgr.injected_document(host, Pos::new(0, 3));
        assert_ne!(host, embedded);
        assert_eq!(mgr.injected_document(host, Pos::new(0, 2)), host);
        assert_eq!(mgr.injected_document(host, Pos::new(0, 9)), host);
        let virtual_path = mgr.snapshot(embedded).unwrap().path;
        assert_eq!(virtual_path.parent(), path.parent());
        assert_eq!(virtual_path.extension().unwrap(), "sql");
        assert!(!virtual_path.exists());
        let loc = Location::file(virtual_path.clone(), Range::new(Pos::default(), Pos::new(0, 99)));
        let mapped = mgr.map_injected_location(loc).unwrap();
        assert_eq!(mapped.path.0, path);
        assert_eq!(mapped.range, injection(3, 9).range);
        let outside = Location::file(virtual_path.clone(), Range::new(Pos::default(), Pos::new(0, 2)));
        assert!(mgr.map_injected_location(outside).is_none());
        let real = root.path().join(".real.openidea-injected-123.sql");
        std::fs::write(&real, "real file").unwrap();
        let other = Location::file(real, Range::default());
        assert_eq!(mgr.map_injected_location(other.clone()), Some(other));
        let mut edit = WorkspaceEdit {
            files: vec![
                FileEdit::Edit {
                    path: virtual_path.clone().into(),
                    edits: vec![
                        ide_core::TextEdit { range: injection(3, 9).range, new_text: "SELECT".into() },
                        ide_core::TextEdit { range: injection(0, 9).range, new_text: "bad".into() },
                    ],
                    version: Some(999),
                },
                FileEdit::Create { path: virtual_path.clone().into(), overwrite: true },
                FileEdit::Rename { from: path.clone().into(), to: virtual_path.clone().into() },
                FileEdit::Delete { path: virtual_path.clone().into(), recursive: false },
            ],
            ..Default::default()
        };
        mgr.map_injected_edit(&mut edit);
        assert_eq!(edit.files.len(), 1);
        assert!(
            matches!(&edit.files[0], FileEdit::Edit { path: p, edits, version: Some(1) } if p.0 == path && edits.len() == 1)
        );
        mgr.set_injections(host, 0, vec![]);
        assert_ne!(mgr.injected_document(host, Pos::new(0, 5)), host, "stale refresh ignored");
        mgr.set_injections(host, 1, vec![]);
        assert_eq!(mgr.injected_document(host, Pos::new(0, 5)), host);
        assert!(mgr.map_injected_location(Location::file(virtual_path, injection(3, 9).range)).is_none());
        mgr.did_open(host, &path, &LanguageId::plain_text(), 2, &"a ".repeat(40));
        mgr.set_injections(host, 2, (0..40).map(|n| injection(n * 2, n * 2 + 1)).collect());
        assert_eq!(mgr.injections.documents.read().len(), 32);
        mgr.did_close(host);
        assert!(mgr.injections.documents.read().is_empty());
        mgr.did_open(host, &path, &LanguageId::plain_text(), 3, &"a".repeat(MAX_INJECTED_DOCUMENT_BYTES + 1));
        mgr.set_injections(host, 3, vec![injection(0, 1)]);
        assert!(mgr.injections.documents.read().is_empty());
    }

    #[test]
    fn diagnostics_merge_fragments_native_source_and_clear() {
        let (mgr, root, events) = manager();
        let host = DocId::next();
        let path = root.path().join("a.java");
        mgr.did_open(host, &path, &LanguageId::plain_text(), 1, "xxsqlxxsql");
        mgr.set_injections(host, 1, vec![injection(2, 5), injection(7, 10)]);
        let a = mgr.snapshot(mgr.injected_document(host, Pos::new(0, 2))).unwrap();
        let b = mgr.snapshot(mgr.injected_document(host, Pos::new(0, 7))).unwrap();
        let server = a.servers[0].clone();
        let diag = |start, end, message: &str| lsp_types::Diagnostic {
            range: lsp_types::Range::new(lsp_types::Position::new(0, start), lsp_types::Position::new(0, end)),
            message: message.into(),
            source: Some("untrusted-source".into()),
            ..Default::default()
        };
        server.set_diagnostics(path.clone(), vec![diag(0, 1, "native")]);
        server.set_diagnostics(a.path.clone(), vec![diag(2, 5, "a"), diag(0, 1, "outside"), diag(4, 6, "crosses")]);
        let items = server.set_diagnostics(b.path.clone(), vec![diag(7, 10, "b")]);
        mgr.emit_diagnostics(&server, b.path, items, Encoding::Utf16);
        let latest = || {
            events
                .lock()
                .iter()
                .rev()
                .find_map(|e| match e {
                    ide_core::IdeEvent::Diagnostics { path: p, source, items }
                        if p.0 == path && source == &server.name =>
                    {
                        Some(items.clone())
                    }
                    _ => None,
                })
                .unwrap()
        };
        assert_eq!(latest().iter().map(|d| d.message.as_str()).collect::<Vec<_>>().len(), 3);
        assert!(
            latest()
                .iter()
                .filter(|d| d.message != "native")
                .all(|d| d.source.as_deref() == Some(server.name.as_str()))
        );
        mgr.set_injections(host, 1, vec![injection(7, 10)]);
        assert_eq!(latest().iter().map(|d| d.message.clone()).collect::<Vec<_>>(), ["native", "b"]);
        mgr.set_injections(host, 1, vec![]);
        assert_eq!(latest()[0].message, "native");
        assert_eq!(latest().len(), 1);
        assert!(
            events.lock().iter().all(|e| !matches!(e, ide_core::IdeEvent::Diagnostics { path, .. } if reserved(path)))
        );
    }

    #[test]
    fn masking_preserves_utf16_crlf_and_line_edges() {
        let text = "😀éSELECT\r\n中sql\r\nend";
        let range = Range::new(Pos::new(0, 3), Pos::new(1, 4));
        assert_eq!(mask(text, range), "   SELECT\r\n中sql\r\n   ");
        assert_eq!(mask(text, range).encode_utf16().count(), text.encode_utf16().count());
        assert_eq!(mask("a\nsql\nz", Range::new(Pos::new(1, 0), Pos::new(2, 0))), " \nsql\n ");
        assert_eq!(mask("sql", Range::new(Pos::new(0, 0), Pos::new(0, 3))), "sql");
    }
    #[test]
    fn boundaries_are_half_open_and_results_clip() {
        let r = Range::new(Pos::new(1, 3), Pos::new(2, 5));
        assert!(contains(r, r.start));
        assert!(!contains(r, r.end));
        assert!(!contains(r, Pos::new(1, 2)));
        assert_eq!(clip(r, Range::new(Pos::new(0, 0), Pos::new(3, 0))), Some(r));
        assert_eq!(clip(r, Range::point(r.end)), None);
        assert_eq!(clip(r, Range::new(Pos::new(0, 0), r.start)), None);
    }
}
