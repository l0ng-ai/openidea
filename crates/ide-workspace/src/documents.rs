use crate::editorconfig::{EditorConfig, EditorConfigProps};
use crate::file_defaults::FileDefaults;
use ide_core::error::ErrorKind;
use ide_core::event::NotifyLevel;
use ide_core::{ChangeSet, DocId, IdeError, IdeEvent, IdeResult, LanguageId, SharedSink, TextEdit};
use ide_text::{AppliedChange, ByteEdit, Document, LineEnding};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// What the UI needs to show an opened document.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
    pub id: DocId,
    pub path: ide_core::IpcPath,
    pub text: String,
    pub version: u32,
    pub language: LanguageId,
    pub encoding: String,
    pub line_ending: LineEnding,
    pub read_only: bool,
    pub dirty: bool,
    /// Larger than `ide_vfs::LARGE_FILE_THRESHOLD`: language servers, syntax
    /// structure and folding are disabled; the editor should drop heavy features.
    #[specta(optional)]
    pub large: bool,
    /// Effective `.editorconfig` properties, when any section applies.
    #[specta(optional)]
    pub editorconfig: Option<EditorConfigProps>,
    /// Set for read-only virtual documents (library classes a language server
    /// provides, e.g. `jdt://…`); `path` then holds the same URI.
    #[specta(optional)]
    pub uri: Option<String>,
    /// CodeMirror mode replacing the language's own one (an Angular project's
    /// HTML templates).
    #[specta(optional)]
    pub ui_mode: Option<String>,
}

/// Current text and identity of a document, for analyses (outline, folding).
#[derive(Clone, Debug)]
pub struct TextSnapshot {
    pub version: u32,
    pub language: LanguageId,
    pub large: bool,
    pub text: String,
}

/// Language of a file from its path and first line (hashbangs).
pub type DetectLanguage = dyn Fn(&Path, Option<&str>) -> LanguageId + Send + Sync;

/// CodeMirror mode of a file replacing its language's own one; `None` keeps it.
pub type DetectUiMode = dyn Fn(&Path, &LanguageId) -> Option<String> + Send + Sync;

/// Registry of open documents keyed by path, with ref-counting so split
/// editors on the same file share one buffer.
///
/// Every document has its own lock; operations on one document are serialized
/// and observers see them in version order.
pub struct Documents {
    registry: Mutex<Registry>,
    observers: RwLock<Vec<Arc<dyn DocumentObserver>>>,
    sink: SharedSink,
    detect_language: Box<DetectLanguage>,
    detect_ui_mode: Box<DetectUiMode>,
    editorconfig: EditorConfig,
    defaults: RwLock<FileDefaults>,
}

/// Hook so other subsystems (LSP sync, local history) observe document life-cycle
/// without `ide-workspace` depending on them.
///
/// Callbacks run synchronously while the document is locked (which keeps them
/// in version order); they must be quick and must not call back into
/// [`Documents`] for the same document. Binary and too-large documents are
/// not reported to observers.
pub trait DocumentObserver: Send + Sync {
    fn opened(&self, _info: &DocumentInfo) {}
    fn changed(
        &self,
        _doc: DocId,
        _path: &Path,
        _version: u32,
        _changes: &[AppliedChange],
        _full_text: &dyn Fn() -> String,
    ) {
    }
    /// The same changes as the preceding [`DocumentObserver::changed`] call, in
    /// byte coordinates of the `\n`-normalized text (incremental re-parsing).
    fn edited(&self, _doc: DocId, _version: u32, _edits: &[ByteEdit]) {}
    fn saved(&self, _doc: DocId, _path: &Path, _text: &str) {}
    fn closed(&self, _doc: DocId, _path: &Path) {}
}

type Slot = Arc<Mutex<DocState>>;

#[derive(Default)]
struct Registry {
    docs: HashMap<DocId, RegEntry>,
    /// Both the path as given and its canonical form map to the document.
    by_key: HashMap<PathBuf, DocId>,
}

struct RegEntry {
    slot: Slot,
    refs: u32,
    keys: Vec<PathBuf>,
}

struct DocState {
    path: PathBuf,
    doc: Document,
    language: LanguageId,
    ui_mode: Option<String>,
    encoding: String,
    has_bom: bool,
    read_only: bool,
    large: bool,
    editorconfig: Option<EditorConfigProps>,
    /// Observers were told about this document (not binary / too large).
    observed: bool,
    binary: bool,
    dirty: bool,
    /// Disk state we last loaded or wrote; changes matching it are our own.
    disk_mtime: f64,
    disk_len: u64,
    closed: bool,
    /// URI of a virtual document (no file behind it).
    uri: Option<String>,
}

fn keys_for(path: &Path) -> Vec<PathBuf> {
    let mut keys = vec![path.to_path_buf()];
    if let Ok(canonical) = dunce::canonicalize(path)
        && canonical != path
    {
        keys.push(canonical);
    }
    keys
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map(|d| d.join(path)).unwrap_or_else(|_| path.to_path_buf())
    }
}

fn disk_len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn read_only_error(path: &Path) -> IdeError {
    IdeError::new(ErrorKind::PermissionDenied, format!("{} is read-only", path.display()))
}

impl Documents {
    pub fn new(sink: SharedSink, detect_language: Box<DetectLanguage>) -> Self {
        Self {
            registry: Mutex::default(),
            observers: RwLock::default(),
            sink,
            detect_language,
            detect_ui_mode: Box::new(|_, _| None),
            editorconfig: EditorConfig::new(),
            defaults: RwLock::default(),
        }
    }

    /// Detects per-file CodeMirror modes (framework templates) besides languages.
    pub fn with_ui_mode_detection(mut self, detect_ui_mode: Box<DetectUiMode>) -> Self {
        self.detect_ui_mode = detect_ui_mode;
        self
    }

    /// The `DocumentInfo::ui_mode` `path` gets when opened, without opening it
    /// (previews of other files).
    pub fn ui_mode_of(&self, path: &Path) -> Option<String> {
        (self.detect_ui_mode)(path, &(self.detect_language)(path, None))
    }

    /// Settings-derived defaults for new files, fallback decoding and EditorConfig support.
    pub fn set_file_defaults(&self, defaults: FileDefaults) {
        *self.defaults.write() = defaults;
    }

    pub fn file_defaults(&self) -> FileDefaults {
        self.defaults.read().clone()
    }

    pub fn add_observer(&self, observer: std::sync::Arc<dyn DocumentObserver>) {
        self.observers.write().push(observer);
    }

    fn observers(&self) -> Vec<Arc<dyn DocumentObserver>> {
        self.observers.read().clone()
    }

    fn slot(&self, doc: DocId) -> IdeResult<Slot> {
        self.registry
            .lock()
            .docs
            .get(&doc)
            .map(|e| e.slot.clone())
            .ok_or_else(|| IdeError::not_found(format!("document {doc} is not open")))
    }

    /// Locks a document, failing if it was closed concurrently.
    fn with_doc<T>(&self, doc: DocId, f: impl FnOnce(&mut DocState) -> IdeResult<T>) -> IdeResult<T> {
        let slot = self.slot(doc)?;
        let mut st = slot.lock();
        if st.closed {
            return Err(IdeError::not_found(format!("document {doc} is not open")));
        }
        f(&mut st)
    }

    /// EditorConfig resolver shared by every document of the project.
    pub fn editorconfig(&self) -> &EditorConfig {
        &self.editorconfig
    }

    fn info(id: DocId, st: &DocState) -> DocumentInfo {
        Self::info_with_text(id, st, st.doc.text())
    }

    fn info_with_text(id: DocId, st: &DocState, text: String) -> DocumentInfo {
        DocumentInfo {
            id,
            path: st.path.clone().into(),
            text,
            version: st.doc.version(),
            language: st.language.clone(),
            encoding: st.encoding.clone(),
            line_ending: st.doc.line_ending(),
            read_only: st.read_only,
            dirty: st.dirty,
            large: st.large,
            editorconfig: st.editorconfig.clone(),
            uri: st.uri.clone(),
            ui_mode: st.ui_mode.clone(),
        }
    }

    fn lookup(reg: &Registry, path: &Path) -> Option<DocId> {
        if let Some(id) = reg.by_key.get(path) {
            return Some(*id);
        }
        if reg.docs.is_empty() {
            return None;
        }
        dunce::canonicalize(path).ok().and_then(|c| reg.by_key.get(&c).copied())
    }

    /// Opens (or re-references) the document at `path`.
    pub fn open(&self, path: &Path) -> IdeResult<DocumentInfo> {
        if let Some(info) = self.reopen(path) {
            return Ok(info);
        }
        let defaults = self.file_defaults();
        let loaded = ide_vfs::load_text_with_fallback(path, defaults.fallback_for(&absolute(path)))?;
        let language = (self.detect_language)(path, loaded.text.lines().next());
        let ui_mode = (self.detect_ui_mode)(path, &language);
        // Archive entries (`<jar>!/<entry>`) are read-only and kept from language
        // servers and Local History, which only know real files.
        let in_archive = ide_vfs::is_archive_path(path);
        let meta = if in_archive { None } else { std::fs::metadata(path).ok() };
        let writable = !in_archive && meta.as_ref().map(|m| !m.permissions().readonly()).unwrap_or(true);
        let empty_file = meta.as_ref().is_some_and(|m| m.len() == 0);
        let observed = !(loaded.binary || loaded.too_large || in_archive);
        let editorconfig = if loaded.binary || in_archive || !defaults.editorconfig {
            None
        } else {
            self.editorconfig.resolve(&absolute(path))
        };
        let mut doc = Document::new(&loaded.text);
        let (mut encoding, mut has_bom) = (loaded.encoding, loaded.has_bom);
        // An empty file has nothing to detect: Code Style / File Encodings defaults apply.
        if empty_file && !loaded.binary {
            doc.set_line_ending(defaults.line_ending);
            encoding = defaults.encoding.clone();
            has_bom = defaults.encoding == "utf-8" && defaults.utf8_bom;
        }
        if let Some(ec) = &editorconfig {
            if let Some(le) = ec.end_of_line {
                doc.set_line_ending(le);
            }
            // An empty file has no detectable encoding: take the configured one.
            if empty_file && let Some((enc, bom)) = ec.encoding() {
                (encoding, has_bom) = (enc.to_owned(), bom);
            }
        }
        // The loaded text doubles as the IPC copy when normalization had nothing
        // to do, so a huge file is held at most twice (rope + response).
        let ipc_text = (!loaded.text.contains('\r')).then_some(loaded.text);
        let state = DocState {
            path: path.to_path_buf(),
            doc,
            language,
            ui_mode,
            encoding,
            has_bom,
            read_only: !observed || !writable,
            large: loaded.large,
            editorconfig,
            observed,
            binary: loaded.binary,
            dirty: false,
            disk_mtime: loaded.mtime_ms,
            disk_len: disk_len(path),
            closed: false,
            uri: None,
        };
        let slot: Slot = Arc::new(Mutex::new(state));
        let st = slot.lock();
        let id = {
            let mut reg = self.registry.lock();
            if Self::lookup(&reg, path).is_some() {
                // Lost a race with a concurrent open of the same file.
                drop(reg);
                drop(st);
                return self.reopen(path).ok_or_else(|| IdeError::internal("document vanished while opening"));
            }
            let id = DocId::next();
            let keys = keys_for(path);
            for k in &keys {
                reg.by_key.insert(k.clone(), id);
            }
            reg.docs.insert(id, RegEntry { slot: slot.clone(), refs: 1, keys });
            id
        };
        let info = match ipc_text {
            Some(text) => Self::info_with_text(id, &st, text),
            None => Self::info(id, &st),
        };
        if st.observed {
            for o in self.observers() {
                o.opened(&info);
            }
        }
        Ok(info)
    }

    /// Opens (or re-references) a read-only virtual document: contents a
    /// language server provides for a non-`file:` URI. It is keyed by the URI,
    /// never touches the disk and cannot be edited or saved.
    pub fn open_virtual(&self, uri: &str, language: LanguageId, text: &str) -> IdeResult<DocumentInfo> {
        let key = PathBuf::from(uri);
        if let Some(info) = self.reopen(&key) {
            return Ok(info);
        }
        let large = text.len() as u64 > ide_vfs::LARGE_FILE_THRESHOLD;
        let state = DocState {
            path: key.clone(),
            doc: Document::new(text),
            language,
            ui_mode: None,
            encoding: "utf-8".into(),
            has_bom: false,
            read_only: true,
            large,
            editorconfig: None,
            observed: true,
            binary: false,
            dirty: false,
            disk_mtime: 0.0,
            disk_len: 0,
            closed: false,
            uri: Some(uri.to_owned()),
        };
        let slot: Slot = Arc::new(Mutex::new(state));
        let st = slot.lock();
        let id = {
            let mut reg = self.registry.lock();
            if reg.by_key.contains_key(&key) {
                drop(reg);
                drop(st);
                return self.reopen(&key).ok_or_else(|| IdeError::internal("document vanished while opening"));
            }
            let id = DocId::next();
            reg.by_key.insert(key.clone(), id);
            reg.docs.insert(id, RegEntry { slot: slot.clone(), refs: 1, keys: vec![key] });
            id
        };
        let info = Self::info(id, &st);
        for o in self.observers() {
            o.opened(&info);
        }
        Ok(info)
    }

    fn reopen(&self, path: &Path) -> Option<DocumentInfo> {
        let slot = {
            let mut reg = self.registry.lock();
            let id = Self::lookup(&reg, path)?;
            let entry = reg.docs.get_mut(&id)?;
            entry.refs += 1;
            (id, entry.slot.clone())
        };
        let st = slot.1.lock();
        Some(Self::info(slot.0, &st))
    }

    pub fn close(&self, doc: DocId) {
        let slot = {
            let mut reg = self.registry.lock();
            let Some(entry) = reg.docs.get_mut(&doc) else { return };
            entry.refs = entry.refs.saturating_sub(1);
            if entry.refs > 0 {
                return;
            }
            let entry = reg.docs.remove(&doc).expect("present");
            for k in &entry.keys {
                if reg.by_key.get(k) == Some(&doc) {
                    reg.by_key.remove(k);
                }
            }
            entry.slot
        };
        let mut st = slot.lock();
        st.closed = true;
        if st.observed {
            for o in self.observers() {
                o.closed(doc, &st.path);
            }
        }
    }

    fn set_dirty(&self, doc: DocId, st: &mut DocState, dirty: bool) {
        if st.dirty != dirty {
            st.dirty = dirty;
            self.sink.emit(IdeEvent::DocDirty { doc, dirty });
        }
    }

    fn notify_changed(&self, doc: DocId, st: &DocState, applied: &[AppliedChange], edits: &[ByteEdit]) {
        if !st.observed {
            return;
        }
        let full_text = || st.doc.text();
        for o in self.observers() {
            o.changed(doc, &st.path, st.doc.version(), applied, &full_text);
            o.edited(doc, st.doc.version(), edits);
        }
    }

    /// Applies an edit from the UI. Returns the new version.
    pub fn edit(&self, doc: DocId, base_version: u32, changes: ChangeSet) -> IdeResult<u32> {
        self.with_doc(doc, |st| {
            if st.read_only {
                return Err(read_only_error(&st.path));
            }
            let (applied, edits) = st.doc.apply_detailed(base_version, &changes)?;
            self.set_dirty(doc, st, true);
            self.notify_changed(doc, st, &applied, &edits);
            Ok(st.doc.version())
        })
    }

    /// Applies a backend-originated edit and emits `IdeEvent::DocPatched`.
    pub fn apply_edits(&self, doc: DocId, edits: &[TextEdit]) -> IdeResult<u32> {
        self.with_doc(doc, |st| {
            if st.read_only {
                return Err(read_only_error(&st.path));
            }
            if edits.is_empty() {
                return Ok(st.doc.version());
            }
            let base_version = st.doc.version();
            let (set, applied, bytes) = st.doc.apply_edits_detailed(edits)?;
            self.patched(doc, st, base_version, set, &applied, &bytes);
            self.set_dirty(doc, st, true);
            Ok(st.doc.version())
        })
    }

    fn patched(
        &self,
        doc: DocId,
        st: &DocState,
        base_version: u32,
        set: ChangeSet,
        applied: &[AppliedChange],
        edits: &[ByteEdit],
    ) {
        self.notify_changed(doc, st, applied, edits);
        self.sink.emit(IdeEvent::DocPatched { doc, base_version, version: st.doc.version(), changes: set.changes });
    }

    /// Minimal-diff replacement; no event when the text is unchanged.
    fn replace_locked(&self, doc: DocId, st: &mut DocState, text: &str) -> IdeResult<bool> {
        let set = st.doc.diff(text);
        if set.changes.is_empty() {
            return Ok(false);
        }
        let base_version = st.doc.version();
        let (applied, edits) = st.doc.apply_detailed(base_version, &set)?;
        self.patched(doc, st, base_version, set, &applied, &edits);
        Ok(true)
    }

    /// Replaces the whole text (minimal diff) and emits `IdeEvent::DocPatched`.
    pub fn replace_all(&self, doc: DocId, text: &str) -> IdeResult<u32> {
        self.with_doc(doc, |st| {
            if st.read_only {
                return Err(read_only_error(&st.path));
            }
            if self.replace_locked(doc, st, text)? {
                self.set_dirty(doc, st, true);
            }
            Ok(st.doc.version())
        })
    }

    /// Writes the document with its original encoding, BOM and line ending.
    /// A clean document is not rewritten.
    pub fn save(&self, doc: DocId) -> IdeResult<()> {
        self.with_doc(doc, |st| {
            if !st.dirty || st.uri.is_some() {
                return Ok(());
            }
            let mtime = ide_vfs::save_text(&st.path, &st.doc.text_for_save(), &st.encoding, st.has_bom)?;
            st.disk_mtime = mtime;
            st.disk_len = disk_len(&st.path);
            self.set_dirty(doc, st, false);
            if st.observed {
                let text = st.doc.text();
                for o in self.observers() {
                    o.saved(doc, &st.path, &text);
                }
            }
            Ok(())
        })
    }

    /// Saves every dirty document; reports the first failure after trying all.
    pub fn save_all(&self) -> IdeResult<()> {
        let ids: Vec<DocId> = self.registry.lock().docs.keys().copied().collect();
        let mut first_err = None;
        for id in ids {
            match self.save(id) {
                Ok(()) => {}
                Err(e) if e.kind == ErrorKind::NotFound && self.slot(id).is_err() => {} // closed meanwhile
                Err(e) => {
                    tracing::warn!("save {id}: {e}");
                    first_err.get_or_insert(e);
                }
            }
        }
        first_err.map_or(Ok(()), Err)
    }

    /// Full snapshot for resync after `OutOfSync`.
    pub fn snapshot(&self, doc: DocId) -> IdeResult<DocumentInfo> {
        self.with_doc(doc, |st| Ok(Self::info(doc, st)))
    }

    /// Text, version and language only (cheaper than [`Documents::snapshot`]).
    pub fn text_snapshot(&self, doc: DocId) -> IdeResult<TextSnapshot> {
        self.with_doc(doc, |st| {
            Ok(TextSnapshot {
                version: st.doc.version(),
                language: st.language.clone(),
                large: st.large,
                text: st.doc.text(),
            })
        })
    }

    pub fn by_path(&self, path: &Path) -> Option<DocId> {
        Self::lookup(&self.registry.lock(), path)
    }

    /// Current text of an open document; `None` if not open (callers read disk).
    pub fn text_of(&self, path: &Path) -> Option<String> {
        let id = self.by_path(path)?;
        self.with_doc(id, |st| Ok(st.doc.text())).ok()
    }

    /// Toggle Read-only Attribute: sets the file's writable bit and, when the
    /// file is open, whether its document accepts edits. Returns the resulting
    /// read-only state.
    pub fn set_writable(&self, path: &Path, writable: bool) -> IdeResult<bool> {
        let open = self.by_path(path);
        if let Some(id) = open
            && self.with_doc(id, |st| Ok(st.uri.is_some()))?
        {
            return Err(IdeError::invalid("library documents are always read-only"));
        }
        ide_vfs::set_writable(path, writable)?;
        match open {
            Some(id) => self.with_doc(id, |st| {
                st.read_only = !st.observed || !writable;
                Ok(st.read_only)
            }),
            None => Ok(!writable),
        }
    }

    /// Whether the document has unsaved changes.
    pub fn is_dirty(&self, doc: DocId) -> IdeResult<bool> {
        self.with_doc(doc, |st| Ok(st.dirty))
    }

    /// Ids of all open documents.
    pub fn open_documents(&self) -> Vec<DocId> {
        self.registry.lock().docs.keys().copied().collect()
    }

    /// Detects the language and UI mode of every open file again (file type
    /// associations changed, a framework's root marker appeared or went). A
    /// document whose language or mode changes is reported as
    /// [`IdeEvent::DocLanguage`]; one whose language changes is also reopened
    /// for the observers, so it moves to the matching language servers and
    /// syntax tree. Returns the changed documents.
    pub fn redetect_languages(&self) -> Vec<DocId> {
        let slots: Vec<(DocId, Slot)> = self.registry.lock().docs.iter().map(|(id, e)| (*id, e.slot.clone())).collect();
        let mut changed = Vec::new();
        for (id, slot) in slots {
            let mut st = slot.lock();
            if st.closed || st.uri.is_some() {
                continue;
            }
            let text = st.doc.text();
            let language = (self.detect_language)(&st.path, text.lines().next());
            let ui_mode = (self.detect_ui_mode)(&st.path, &language);
            if language == st.language && ui_mode == st.ui_mode {
                continue;
            }
            st.ui_mode = ui_mode;
            if language != st.language {
                st.language = language.clone();
                if st.observed {
                    let info = Self::info_with_text(id, &st, text);
                    for o in self.observers() {
                        o.closed(id, &st.path);
                        o.opened(&info);
                    }
                }
            }
            self.sink.emit(IdeEvent::DocLanguage { doc: id, language, ui_mode: st.ui_mode.clone() });
            changed.push(id);
        }
        changed
    }

    /// Changes the line ending used on save; marks the document dirty.
    pub fn set_line_ending(&self, doc: DocId, le: LineEnding) -> IdeResult<()> {
        self.with_doc(doc, |st| {
            if st.doc.line_ending() == le {
                return Ok(());
            }
            if st.read_only {
                return Err(read_only_error(&st.path));
            }
            st.doc.set_line_ending(le);
            self.set_dirty(doc, st, true);
            Ok(())
        })
    }

    /// Changes the document's encoding. `reload`: re-decode the file on disk with
    /// it (refused while there are unsaved changes); otherwise convert: the text
    /// is kept and the next save writes it in the new encoding.
    pub fn set_encoding(&self, doc: DocId, encoding: &str, reload: bool) -> IdeResult<String> {
        self.with_doc(doc, |st| {
            if st.uri.is_some() {
                return Err(read_only_error(&st.path));
            }
            if reload {
                if st.dirty {
                    return Err(IdeError::invalid("save or revert the unsaved changes before reloading"));
                }
                let loaded = ide_vfs::load_text_as(&st.path, encoding)?;
                st.encoding = loaded.encoding.clone();
                st.has_bom = loaded.has_bom;
                st.disk_mtime = loaded.mtime_ms;
                self.replace_locked(doc, st, &loaded.text)?;
                // Reloading is not an edit: the buffer matches the file again.
                self.set_dirty(doc, st, false);
                return Ok(loaded.encoding);
            }
            if st.read_only {
                return Err(read_only_error(&st.path));
            }
            let utf16 = encoding.starts_with("utf-16");
            let has_bom = utf16 || (st.has_bom && encoding == "utf-8");
            // Fails (with the offending character) when the text is not representable.
            ide_vfs::encode(&st.doc.text_for_save(), encoding, has_bom)?;
            st.encoding = encoding.to_owned();
            st.has_bom = has_bom;
            self.set_dirty(doc, st, true);
            Ok(st.encoding.clone())
        })
    }

    /// Re-reads from disk after an external change. Clean documents reload
    /// silently; dirty ones are left alone and reported via `IdeEvent::Notify`.
    /// Changes matching our own last save are ignored.
    pub fn on_disk_changed(&self, paths: &[PathBuf]) {
        for path in paths {
            let Some(id) = self.by_path(path) else { continue };
            let result = self.with_doc(id, |st| {
                let Ok(meta) = std::fs::metadata(&st.path) else { return Ok(()) };
                let mtime = ide_vfs::mtime_ms(&meta);
                if mtime == st.disk_mtime && meta.len() == st.disk_len {
                    return Ok(());
                }
                if st.dirty {
                    st.disk_mtime = mtime;
                    st.disk_len = meta.len();
                    let name = st.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    self.sink.emit(IdeEvent::Notify {
                        level: NotifyLevel::Warning,
                        title: format!("{name} changed on disk"),
                        body: Some(format!(
                            "{} was modified externally but has unsaved changes in the editor. \
                             Saving will overwrite the external changes.",
                            st.path.display()
                        )),
                    });
                    return Ok(());
                }
                let loaded = ide_vfs::load_text(&st.path)?;
                st.disk_mtime = loaded.mtime_ms;
                st.disk_len = disk_len(&st.path);
                if loaded.binary || st.binary {
                    return Ok(());
                }
                st.encoding = loaded.encoding;
                st.has_bom = loaded.has_bom;
                st.large = loaded.large;
                let ec_eol = st.editorconfig.as_ref().and_then(|ec| ec.end_of_line);
                st.doc.set_line_ending(ec_eol.unwrap_or_else(|| LineEnding::detect(&loaded.text)));
                self.replace_locked(id, st, &loaded.text)?;
                Ok(())
            });
            if let Err(e) = result {
                tracing::warn!("reload {}: {e}", path.display());
            }
        }
    }
}
