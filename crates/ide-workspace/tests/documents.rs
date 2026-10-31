use ide_core::error::ErrorKind;
use ide_core::event::NotifyLevel;
use ide_core::{ChangeSet, DocId, IdeEvent, LanguageId, Pos, Range, SharedSink, TextChange, TextEdit};
use ide_text::{AppliedChange, LineEnding};
use ide_workspace::documents::DocumentObserver;
use ide_workspace::{DocumentInfo, Documents};
use parking_lot::Mutex;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Default)]
struct Recorder {
    log: Mutex<Vec<String>>,
}

impl DocumentObserver for Recorder {
    fn opened(&self, info: &DocumentInfo) {
        self.log.lock().push(format!("open v{} {}", info.version, info.language));
    }
    fn changed(&self, _: DocId, _: &Path, version: u32, changes: &[AppliedChange], full: &dyn Fn() -> String) {
        self.log.lock().push(format!("change v{version} n{} {:?}", changes.len(), full()));
    }
    fn saved(&self, _: DocId, _: &Path, text: &str) {
        self.log.lock().push(format!("save {text:?}"));
    }
    fn closed(&self, _: DocId, _: &Path) {
        self.log.lock().push("close".into());
    }
}

struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    docs: Documents,
    events: Arc<Mutex<Vec<IdeEvent>>>,
    rec: Arc<Recorder>,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let sink: SharedSink = {
        let events = events.clone();
        Arc::new(move |e: IdeEvent| events.lock().push(e))
    };
    let docs = Documents::new(
        sink,
        Box::new(|p: &Path, _: Option<&str>| match p.extension().and_then(|e| e.to_str()) {
            Some("rs") => LanguageId::new("rust"),
            _ => LanguageId::plain_text(),
        }),
    );
    let rec = Arc::new(Recorder::default());
    docs.add_observer(rec.clone());
    Fixture { _tmp: tmp, root, docs, events, rec }
}

fn change(from: u32, to: u32, insert: &str) -> ChangeSet {
    ChangeSet { changes: vec![TextChange { from, to, insert: insert.into() }] }
}

#[test]
fn redetect_reopens_documents_whose_language_changed() {
    let tmp = tempfile::tempdir().unwrap();
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let sink: SharedSink = {
        let events = events.clone();
        Arc::new(move |e: IdeEvent| events.lock().push(e))
    };
    let foo_is_python = Arc::new(Mutex::new(false));
    let docs = {
        let foo_is_python = foo_is_python.clone();
        Documents::new(
            sink,
            Box::new(move |p: &Path, first: Option<&str>| {
                if p.extension().is_some_and(|e| e == "foo") && *foo_is_python.lock() {
                    LanguageId::new("python")
                } else if first.is_some_and(|l| l.starts_with("#!")) {
                    LanguageId::new("shellscript")
                } else {
                    LanguageId::plain_text()
                }
            }),
        )
    };
    let rec = Arc::new(Recorder::default());
    docs.add_observer(rec.clone());
    let foo = tmp.path().join("a.foo");
    let script = tmp.path().join("run");
    fs::write(&foo, "x = 1\n").unwrap();
    fs::write(&script, "#!/bin/sh\necho\n").unwrap();
    let a = docs.open(&foo).unwrap();
    assert_eq!(a.language.as_str(), "plaintext");
    assert_eq!(docs.open(&script).unwrap().language.as_str(), "shellscript", "the first line is detected");

    assert!(docs.redetect_languages().is_empty());
    *foo_is_python.lock() = true;
    assert_eq!(docs.redetect_languages(), vec![a.id]);
    assert_eq!(docs.snapshot(a.id).unwrap().language.as_str(), "python");
    let log = rec.log.lock().clone();
    assert_eq!(log[log.len() - 2..], ["close".to_owned(), "open v0 python".to_owned()]);
    assert!(events.lock().iter().any(
        |e| matches!(e, IdeEvent::DocLanguage { doc, language, .. } if *doc == a.id && language.as_str() == "python")
    ));
}

#[test]
fn ui_modes_are_detected_with_the_language() {
    let tmp = tempfile::tempdir().unwrap();
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let sink: SharedSink = {
        let events = events.clone();
        Arc::new(move |e: IdeEvent| events.lock().push(e))
    };
    let tpl_is_html = Arc::new(Mutex::new(false));
    let docs = {
        let tpl_is_html = tpl_is_html.clone();
        Documents::new(
            sink,
            Box::new(move |p: &Path, _: Option<&str>| match p.extension().and_then(|e| e.to_str()) {
                Some("html") => LanguageId::new("html"),
                Some("tpl") if *tpl_is_html.lock() => LanguageId::new("html"),
                _ => LanguageId::plain_text(),
            }),
        )
        .with_ui_mode_detection(Box::new(|p: &Path, lang: &LanguageId| {
            (lang.as_str() == "html" && p.parent().is_some_and(|d| d.ends_with("ng")))
                .then(|| "Angular Template".into())
        }))
    };
    fs::create_dir_all(tmp.path().join("ng")).unwrap();
    let (template, page, tpl) =
        (tmp.path().join("ng/app.html"), tmp.path().join("index.html"), tmp.path().join("ng/a.tpl"));
    for p in [&template, &page, &tpl] {
        fs::write(p, "<p></p>\n").unwrap();
    }
    assert_eq!(docs.open(&template).unwrap().ui_mode.as_deref(), Some("Angular Template"));
    assert_eq!(docs.open(&page).unwrap().ui_mode, None);
    let a = docs.open(&tpl).unwrap();
    assert_eq!(a.ui_mode, None);

    *tpl_is_html.lock() = true;
    assert_eq!(docs.redetect_languages(), vec![a.id]);
    assert_eq!(docs.snapshot(a.id).unwrap().ui_mode.as_deref(), Some("Angular Template"));
    assert!(events.lock().iter().any(|e| matches!(
        e,
        IdeEvent::DocLanguage { doc, ui_mode: Some(mode), .. } if *doc == a.id && mode == "Angular Template"
    )));
}

#[test]
fn ui_modes_are_redetected_without_a_language_change() {
    let tmp = tempfile::tempdir().unwrap();
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let sink: SharedSink = {
        let events = events.clone();
        Arc::new(move |e: IdeEvent| events.lock().push(e))
    };
    let docs = Documents::new(sink, Box::new(|_: &Path, _: Option<&str>| LanguageId::new("html")))
        .with_ui_mode_detection(Box::new(|p: &Path, _: &LanguageId| {
            p.parent().is_some_and(|d| d.join("angular.json").exists()).then(|| "Angular Template".into())
        }));
    let rec = Arc::new(Recorder::default());
    docs.add_observer(rec.clone());
    let (template, marker) = (tmp.path().join("app.html"), tmp.path().join("angular.json"));
    fs::write(&template, "<p></p>\n").unwrap();
    let a = docs.open(&template).unwrap();
    assert_eq!(a.ui_mode, None);
    let opened = rec.log.lock().len();

    fs::write(&marker, "{}").unwrap();
    assert_eq!(docs.ui_mode_of(&template).as_deref(), Some("Angular Template"));
    assert_eq!(docs.redetect_languages(), vec![a.id]);
    assert_eq!(docs.snapshot(a.id).unwrap().ui_mode.as_deref(), Some("Angular Template"));
    assert!(docs.redetect_languages().is_empty());
    fs::remove_file(&marker).unwrap();
    assert_eq!(docs.redetect_languages(), vec![a.id]);
    assert_eq!(docs.snapshot(a.id).unwrap().ui_mode, None);

    let modes: Vec<Option<String>> = events
        .lock()
        .iter()
        .filter_map(|e| match e {
            IdeEvent::DocLanguage { doc, language, ui_mode } if *doc == a.id && language.as_str() == "html" => {
                Some(ui_mode.clone())
            }
            _ => None,
        })
        .collect();
    assert_eq!(modes, [Some("Angular Template".to_owned()), None]);
    assert_eq!(rec.log.lock().len(), opened, "language servers keep the document");
}

fn dirty_events(events: &[IdeEvent]) -> Vec<bool> {
    events.iter().filter_map(|e| if let IdeEvent::DocDirty { dirty, .. } = e { Some(*dirty) } else { None }).collect()
}

#[test]
fn open_edit_save_close() {
    let f = fixture();
    let path = f.root.join("main.rs");
    fs::write(&path, "fn main() {}\r\n").unwrap();

    let info = f.docs.open(&path).unwrap();
    assert_eq!(info.text, "fn main() {}\n");
    assert_eq!(info.line_ending, LineEnding::CrLf);
    assert_eq!(info.language.as_str(), "rust");
    assert_eq!(info.encoding, "utf-8");
    assert!(!info.read_only && !info.dirty);

    // Ref-counted re-open shares the buffer.
    let again = f.docs.open(&path).unwrap();
    assert_eq!(again.id, info.id);
    assert_eq!(f.docs.by_path(&path), Some(info.id));

    let v = f.docs.edit(info.id, 0, change(12, 12, " // hi")).unwrap();
    assert_eq!(v, 1);
    let v = f.docs.edit(info.id, 1, change(0, 0, "pub ")).unwrap();
    assert_eq!(v, 2);
    assert_eq!(f.docs.edit(info.id, 1, change(0, 0, "x")).unwrap_err().kind, ErrorKind::OutOfSync);
    assert_eq!(f.docs.text_of(&path).unwrap(), "pub fn main() {} // hi\n");
    assert!(f.docs.snapshot(info.id).unwrap().dirty);
    assert_eq!(dirty_events(&f.events.lock()), vec![true]);

    f.docs.save(info.id).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "pub fn main() {} // hi\r\n");
    assert!(!f.docs.snapshot(info.id).unwrap().dirty);
    assert_eq!(dirty_events(&f.events.lock()), vec![true, false]);

    // Our own save must not trigger a reload.
    let before = f.events.lock().len();
    f.docs.on_disk_changed(std::slice::from_ref(&path));
    assert_eq!(f.events.lock().len(), before);

    f.docs.close(info.id);
    assert!(f.docs.snapshot(info.id).is_ok(), "still referenced once");
    f.docs.close(info.id);
    assert_eq!(f.docs.snapshot(info.id).unwrap_err().kind, ErrorKind::NotFound);
    assert_eq!(f.docs.by_path(&path), None);
    assert_eq!(f.docs.text_of(&path), None);

    assert_eq!(
        *f.rec.log.lock(),
        vec![
            "open v0 rust".to_string(),
            "change v1 n1 \"fn main() {} // hi\\n\"".into(),
            "change v2 n1 \"pub fn main() {} // hi\\n\"".into(),
            "save \"pub fn main() {} // hi\\n\"".into(),
            "close".into(),
        ]
    );
}

#[test]
fn backend_edits_emit_patches() {
    let f = fixture();
    let path = f.root.join("a.txt");
    fs::write(&path, "one\ntwo\nthree\n").unwrap();
    let id = f.docs.open(&path).unwrap().id;

    let v = f
        .docs
        .apply_edits(
            id,
            &[
                TextEdit { range: Range::new(Pos::new(2, 0), Pos::new(2, 5)), new_text: "THREE".into() },
                TextEdit { range: Range::new(Pos::new(0, 0), Pos::new(0, 3)), new_text: "ONE".into() },
            ],
        )
        .unwrap();
    assert_eq!(v, 1);
    let v = f.docs.replace_all(id, "ONE\n2\nTHREE\n").unwrap();
    assert_eq!(v, 2);
    assert_eq!(f.docs.replace_all(id, "ONE\n2\nTHREE\n").unwrap(), 2, "no-op replace keeps version");
    assert_eq!(f.docs.apply_edits(id, &[]).unwrap(), 2);

    let patches: Vec<(u32, u32, Vec<TextChange>)> = f
        .events
        .lock()
        .iter()
        .filter_map(|e| match e {
            IdeEvent::DocPatched { base_version, version, changes, .. } => {
                Some((*base_version, *version, changes.clone()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        patches,
        vec![
            (
                0,
                1,
                vec![
                    TextChange { from: 0, to: 3, insert: "ONE".into() },
                    TextChange { from: 8, to: 13, insert: "THREE".into() }
                ]
            ),
            (1, 2, vec![TextChange { from: 4, to: 7, insert: "2".into() }]),
        ]
    );

    let overlapping = [
        TextEdit { range: Range::new(Pos::new(0, 0), Pos::new(0, 3)), new_text: "x".into() },
        TextEdit { range: Range::new(Pos::new(0, 1), Pos::new(0, 2)), new_text: "y".into() },
    ];
    assert_eq!(f.docs.apply_edits(id, &overlapping).unwrap_err().kind, ErrorKind::InvalidInput);

    f.docs.set_line_ending(id, LineEnding::CrLf).unwrap();
    f.docs.save_all().unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "ONE\r\n2\r\nTHREE\r\n");
}

#[test]
fn external_changes() {
    let f = fixture();
    let path = f.root.join("ext.txt");
    fs::write(&path, "alpha\nbeta\n").unwrap();
    let id = f.docs.open(&path).unwrap().id;

    // Clean document: reloads with a minimal patch, stays clean.
    std::thread::sleep(std::time::Duration::from_millis(10));
    fs::write(&path, "alpha\nBETA\ngamma\n").unwrap();
    f.docs.on_disk_changed(std::slice::from_ref(&path));
    let snap = f.docs.snapshot(id).unwrap();
    assert_eq!(snap.text, "alpha\nBETA\ngamma\n");
    assert_eq!(snap.version, 1);
    assert!(!snap.dirty);
    assert!(f.events.lock().iter().any(|e| matches!(e, IdeEvent::DocPatched { base_version: 0, version: 1, .. })));
    assert!(dirty_events(&f.events.lock()).is_empty());

    // Dirty document: not clobbered, warning instead.
    f.docs.edit(id, 1, change(0, 0, "// ")).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    fs::write(&path, "something else\n").unwrap();
    f.docs.on_disk_changed(std::slice::from_ref(&path));
    assert_eq!(f.docs.snapshot(id).unwrap().text, "// alpha\nBETA\ngamma\n");
    let warnings =
        f.events.lock().iter().filter(|e| matches!(e, IdeEvent::Notify { level: NotifyLevel::Warning, .. })).count();
    assert_eq!(warnings, 1);
    // The same disk state is reported only once.
    f.docs.on_disk_changed(std::slice::from_ref(&path));
    let warnings =
        f.events.lock().iter().filter(|e| matches!(e, IdeEvent::Notify { level: NotifyLevel::Warning, .. })).count();
    assert_eq!(warnings, 1);

    // Unknown paths are ignored.
    f.docs.on_disk_changed(&[f.root.join("other.txt")]);
}

#[test]
fn encodings_and_read_only() {
    let f = fixture();
    let gbk_path = f.root.join("gbk.txt");
    let (bytes, _, _) = encoding_rs::GBK.encode("这是一段比较长的中文文本，用于测试编码检测是否正确。\n");
    fs::write(&gbk_path, &bytes).unwrap();
    let info = f.docs.open(&gbk_path).unwrap();
    assert_eq!(info.encoding, "gbk");
    f.docs.edit(info.id, 0, change(0, 0, "前言")).unwrap();
    f.docs.save(info.id).unwrap();
    let saved = fs::read(&gbk_path).unwrap();
    let (decoded, _, _) = encoding_rs::GBK.decode(&saved);
    assert_eq!(decoded, "前言这是一段比较长的中文文本，用于测试编码检测是否正确。\n");

    let bom_path = f.root.join("bom.txt");
    fs::write(&bom_path, b"\xEF\xBB\xBFhello").unwrap();
    let info = f.docs.open(&bom_path).unwrap();
    f.docs.edit(info.id, 0, change(5, 5, "!")).unwrap();
    f.docs.save(info.id).unwrap();
    assert_eq!(fs::read(&bom_path).unwrap(), b"\xEF\xBB\xBFhello!");

    let bin_path = f.root.join("img.png");
    fs::write(&bin_path, [0x89, b'P', b'N', b'G', 0, 0, 0, 0]).unwrap();
    let info = f.docs.open(&bin_path).unwrap();
    assert!(info.read_only);
    assert!(info.text.is_empty());
    assert_eq!(f.docs.edit(info.id, 0, change(0, 0, "x")).unwrap_err().kind, ErrorKind::PermissionDenied);
    f.docs.close(info.id);
    // Binary docs are never reported to observers.
    let opens = f.rec.log.lock().iter().filter(|l| l.starts_with("open")).count();
    assert_eq!(opens, 2);
    assert!(!f.rec.log.lock().iter().any(|l| l == "close"));

    assert_eq!(f.docs.open(&f.root.join("missing.txt")).unwrap_err().kind, ErrorKind::NotFound);
}

#[test]
fn reload_and_convert_encoding() {
    let f = fixture();
    let path = f.root.join("mis.txt");
    let (bytes, _, _) = encoding_rs::GBK.encode("中文内容");
    fs::write(&path, &bytes).unwrap();
    let info = f.docs.open(&path).unwrap();
    assert_eq!(f.docs.set_encoding(info.id, "gbk", true).unwrap(), "gbk");
    assert_eq!(f.docs.snapshot(info.id).unwrap().text, "中文内容");

    // Convert: same text, written in the new encoding on save.
    assert_eq!(f.docs.set_encoding(info.id, "utf-8", false).unwrap(), "utf-8");
    f.docs.save(info.id).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "中文内容");

    // Not representable → refused, encoding unchanged.
    assert!(f.docs.set_encoding(info.id, "windows-1252", false).is_err());
    // Reload refuses unsaved changes.
    f.docs.edit(info.id, f.docs.snapshot(info.id).unwrap().version, change(0, 0, "x")).unwrap();
    assert!(f.docs.set_encoding(info.id, "gbk", true).is_err());
}

#[cfg(unix)]
#[test]
fn symlinked_path_maps_to_same_document() {
    let f = fixture();
    let real = f.root.join("real.txt");
    fs::write(&real, "x").unwrap();
    let link = f.root.join("link.txt");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let a = f.docs.open(&real).unwrap();
    assert_eq!(f.docs.by_path(&link), Some(a.id));
    let b = f.docs.open(&link).unwrap();
    assert_eq!(a.id, b.id);
}

#[derive(Default)]
struct ByteRecorder {
    edits: Mutex<Vec<(u32, Vec<ide_text::ByteEdit>)>>,
}

impl DocumentObserver for ByteRecorder {
    fn edited(&self, _: DocId, version: u32, edits: &[ide_text::ByteEdit]) {
        self.edits.lock().push((version, edits.to_vec()));
    }
}

#[test]
fn observers_receive_byte_edits() {
    let f = fixture();
    let rec = Arc::new(ByteRecorder::default());
    f.docs.add_observer(rec.clone());
    let path = f.root.join("a.rs");
    fs::write(&path, "é\nab\n").unwrap();
    let info = f.docs.open(&path).unwrap();
    f.docs.edit(info.id, 0, change(3, 4, "XY\n")).unwrap();
    f.docs.apply_edits(info.id, &[TextEdit { range: Range::point(Pos::new(0, 0)), new_text: "// ".into() }]).unwrap();
    f.docs.replace_all(info.id, "nothing").unwrap();
    let edits = rec.edits.lock().clone();
    assert_eq!(edits.iter().map(|(v, _)| *v).collect::<Vec<_>>(), vec![1, 2, 3]);
    let e = edits[0].1[0];
    // "é" is two bytes: offset 3 (UTF-16) = byte 4 = row 1, byte column 1.
    assert_eq!((e.start_byte, e.old_end_byte, e.new_end_byte), (4, 5, 7));
    assert_eq!((e.start.row, e.start.col, e.new_end.row, e.new_end.col), (1, 1, 2, 0));
    let snap = f.docs.text_snapshot(info.id).unwrap();
    assert_eq!((snap.version, snap.text.as_str(), snap.large), (3, "nothing", false));
    assert_eq!(snap.language, LanguageId::new("rust"));
}

#[test]
fn large_files_degrade() {
    let f = fixture();
    let line = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\n";
    let big = line.repeat((ide_vfs::LARGE_FILE_THRESHOLD as usize) / line.len() + 1);
    let path = f.root.join("big.log");
    fs::write(&path, &big).unwrap();
    let info = f.docs.open(&path).unwrap();
    assert!(info.large && !info.read_only);
    assert_eq!(info.text.len(), big.len());
    f.docs.edit(info.id, 0, change(0, 0, "x")).unwrap();
    let json = serde_json::to_value(&info).unwrap_or_default();
    assert_eq!(json.get("large"), Some(&serde_json::Value::Bool(true)));

    let huge_path = f.root.join("huge.log");
    let huge = line.repeat((ide_vfs::READ_ONLY_THRESHOLD as usize) / line.len() + 1);
    fs::write(&huge_path, &huge).unwrap();
    drop(huge);
    let start = std::time::Instant::now();
    let info = f.docs.open(&huge_path).unwrap();
    assert!(info.large && info.read_only);
    assert_eq!(f.docs.edit(info.id, 0, change(0, 0, "x")).unwrap_err().kind, ErrorKind::PermissionDenied);
    // Generous bound for debug builds; the point is "no quadratic work".
    assert!(start.elapsed() < std::time::Duration::from_secs(20), "{:?}", start.elapsed());

    let small = f.root.join("small.rs");
    fs::write(&small, "fn x() {}\n").unwrap();
    let info = f.docs.open(&small).unwrap();
    assert!(!info.large);
    let json = serde_json::to_value(&info).unwrap_or_default();
    assert_eq!(json["editorconfig"], serde_json::Value::Null, "null when no .editorconfig applies");
}

#[test]
fn editorconfig_applies_on_open_and_save() {
    let f = fixture();
    fs::write(
        f.root.join(".editorconfig"),
        "root = true\n[*]\nend_of_line = crlf\nindent_style = tab\ntab_width = 3\ninsert_final_newline = true\n\
         [*.u16]\ncharset = utf-16le\n[*.keep]\nend_of_line = unset\n",
    )
    .unwrap();
    let path = f.root.join("a.txt");
    fs::write(&path, "one\ntwo\n").unwrap();
    let info = f.docs.open(&path).unwrap();
    assert_eq!(info.line_ending, LineEnding::CrLf);
    let ec = info.editorconfig.clone().unwrap();
    assert_eq!(
        (ec.indent_style, ec.indent_size, ec.tab_width),
        (Some(ide_workspace::editorconfig::IndentStyle::Tab), Some(3), Some(3))
    );
    assert_eq!(ec.insert_final_newline, Some(true));
    assert!(!info.dirty);
    f.docs.edit(info.id, 0, change(0, 0, "zero\n")).unwrap();
    f.docs.save(info.id).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "zero\r\none\r\ntwo\r\n");

    // Without end_of_line the detected ending is kept.
    let keep = f.root.join("x.keep");
    fs::write(&keep, "a\nb\n").unwrap();
    assert_eq!(f.docs.open(&keep).unwrap().line_ending, LineEnding::Lf);

    // New (empty) files take the configured charset.
    let new = f.root.join("new.u16");
    ide_workspace::editorconfig::create_file(f.docs.editorconfig(), &new).unwrap();
    assert_eq!(fs::read(&new).unwrap(), [0xFF, 0xFE]);
    let empty = f.root.join("empty.u16");
    fs::write(&empty, "").unwrap();
    let info = f.docs.open(&empty).unwrap();
    assert_eq!((info.encoding.as_str(), info.line_ending), ("utf-16le", LineEnding::CrLf));
    f.docs.edit(info.id, 0, change(0, 0, "A\nB")).unwrap();
    f.docs.save(info.id).unwrap();
    let expected: Vec<u8> =
        [0xFF, 0xFE].into_iter().chain("A\r\nB".encode_utf16().flat_map(u16::to_le_bytes)).collect();
    assert_eq!(fs::read(&empty).unwrap(), expected);
}

#[test]
fn virtual_documents_are_read_only_and_keyed_by_uri() {
    let f = fixture();
    let uri = "jdt://contents/a.jar/p/C.class?=x";
    let info = f.docs.open_virtual(uri, LanguageId::new("java"), "class C {}\n").unwrap();
    assert_eq!(info.uri.as_deref(), Some(uri));
    assert_eq!(info.path, PathBuf::from(uri));
    assert!(info.read_only && !info.dirty);
    assert_eq!(info.language.as_str(), "java");

    // Re-opening shares the document; edits and saves never reach a file.
    let again = f.docs.open_virtual(uri, LanguageId::new("java"), "ignored").unwrap();
    assert_eq!(again.id, info.id);
    assert_eq!(again.text, "class C {}\n");
    let err = f.docs.edit(info.id, info.version, change(0, 0, "x")).unwrap_err();
    assert_eq!(err.kind, ErrorKind::PermissionDenied);
    f.docs.save(info.id).unwrap();
    assert!(f.docs.set_encoding(info.id, "utf-16le", true).is_err());

    f.docs.close(info.id);
    f.docs.close(info.id);
    assert!(f.docs.snapshot(info.id).is_err());
    assert_eq!(*f.rec.log.lock(), vec!["open v0 java".to_owned(), "close".to_owned()]);
}

#[test]
fn toggling_the_writable_bit_updates_the_open_document() {
    let f = fixture();
    let path = f.root.join("notes.txt");
    fs::write(&path, "hello").unwrap();
    let info = f.docs.open(&path).unwrap();
    assert!(!info.read_only);

    assert!(f.docs.set_writable(&path, false).unwrap());
    assert!(fs::metadata(&path).unwrap().permissions().readonly());
    assert!(f.docs.snapshot(info.id).unwrap().read_only);
    assert_eq!(f.docs.edit(info.id, 0, change(0, 0, "x")).unwrap_err().kind, ErrorKind::PermissionDenied);

    assert!(!f.docs.set_writable(&path, true).unwrap());
    assert!(!f.docs.snapshot(info.id).unwrap().read_only);
    f.docs.edit(info.id, 0, change(0, 0, "x")).unwrap();
    f.docs.save(info.id).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "xhello");

    // Files that are not open only change on disk.
    let other = f.root.join("other.txt");
    fs::write(&other, "").unwrap();
    assert!(f.docs.set_writable(&other, false).unwrap());
    assert!(fs::metadata(&other).unwrap().permissions().readonly());
}

#[test]
fn archive_entries_open_read_only_without_observers() {
    use std::io::Write;
    let f = fixture();
    let jar = f.root.join("lib-sources.jar");
    let mut w = zip::ZipWriter::new(fs::File::create(&jar).unwrap());
    w.start_file("org/x/Main.rs", zip::write::SimpleFileOptions::default()).unwrap();
    w.write_all(b"fn main() {}\n").unwrap();
    w.finish().unwrap();
    let path = ide_vfs::archive_entry_path(&jar, "org/x/Main.rs");
    let info = f.docs.open(&path).unwrap();
    assert_eq!((info.text.as_str(), info.language.as_str(), info.read_only), ("fn main() {}\n", "rust", true));
    assert_eq!(*info.path, *path);
    assert!(f.rec.log.lock().is_empty(), "language servers / history never see archive entries");
    fs::remove_file(&jar).unwrap();
    f.docs.sync_from_disk();
    assert_eq!(f.docs.snapshot(info.id).unwrap().version, info.version);
    assert_eq!(f.docs.snapshot(info.id).unwrap().text, info.text);
    f.docs.close(info.id);
}

#[test]
fn properties_conversion_uses_displayed_utf16_and_survives_reload() {
    let f = fixture();
    let path = f.root.join("messages.properties");
    let original = "greeting=\\u4f60\\u597d\\uD83D\\uDE00!\r\nliteral=\\\\u0041\r\nbad=\\u12xz\r\n";
    fs::write(&path, original).unwrap();
    let mut defaults = f.docs.file_defaults();
    defaults.native_to_ascii = true;
    f.docs.set_file_defaults(defaults);
    let doc = f.docs.open(&path).unwrap();
    assert_eq!(doc.text, "greeting=你好😀!\nliteral=\\\\u0041\nbad=\\u12xz\n");
    assert!(!doc.dirty);
    assert_eq!(f.docs.text_snapshot(doc.id).unwrap().text, doc.text);
    f.docs.save(doc.id).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original.as_bytes());
    // Two BMP characters + one surrogate pair put ! at UTF-16 offset 13.
    f.docs.edit(doc.id, doc.version, change(13, 14, "界")).unwrap();
    f.docs.save(doc.id).unwrap();
    let expected = "greeting=\\u4F60\\u597D\\uD83D\\uDE00\\u754C\r\nliteral=\\\\u0041\r\nbad=\\u12xz\r\n";
    assert_eq!(fs::read(&path).unwrap(), expected.as_bytes());
    assert!(f.rec.log.lock().iter().any(|line| line.contains("greeting=你好😀界")));
    let saved = f.docs.snapshot(doc.id).unwrap();
    f.docs.set_encoding(doc.id, "iso-8859-1", true).unwrap();
    assert_eq!(f.docs.snapshot(doc.id).unwrap().version, saved.version);
    // Force a watcher event even though the serialized contents are identical.
    fs::File::options().write(true).open(&path).unwrap().set_modified(std::time::SystemTime::UNIX_EPOCH).unwrap();
    f.docs.on_disk_changed(std::slice::from_ref(&path));
    let reloaded = f.docs.snapshot(doc.id).unwrap();
    assert_eq!(reloaded.text, saved.text);
    assert_eq!(reloaded.version, saved.version);
    assert!(!reloaded.dirty);
    fs::write(&path, "greeting=\\u4E16\\u754C\r\n").unwrap();
    f.docs.on_disk_changed(std::slice::from_ref(&path));
    assert_eq!(f.docs.snapshot(doc.id).unwrap().text, "greeting=世界\n");
    assert!(!f.docs.is_dirty(doc.id).unwrap());
}

#[test]
fn properties_toggle_reloads_only_clean_properties_and_pins_dirty_codec() {
    let f = fixture();
    let paths = ["clean.properties", "dirty.properties", "other.txt"].map(|name| f.root.join(name));
    for path in &paths {
        fs::write(path, r"value=\u4F60").unwrap();
    }
    let [clean, dirty, other] = paths.each_ref().map(|p| f.docs.open(p).unwrap());
    f.docs.edit(dirty.id, dirty.version, change(12, 12, "!")).unwrap();
    let mut defaults = f.docs.file_defaults();
    defaults.native_to_ascii = true;
    f.docs.set_file_defaults(defaults.clone());
    f.docs.reload_properties();
    assert_eq!(f.docs.snapshot(clean.id).unwrap().text, "value=你");
    assert!(!f.docs.is_dirty(clean.id).unwrap());
    assert_eq!(f.docs.snapshot(dirty.id).unwrap().text, r"value=\u4F60!");
    assert!(!f.docs.native_to_ascii_for(&paths[1]));
    assert_eq!(f.docs.snapshot(other.id).unwrap().text, r"value=\u4F60");
    f.docs.save(dirty.id).unwrap();
    assert_eq!(fs::read_to_string(&paths[1]).unwrap(), r"value=\u4F60!");
    f.docs.reload_properties();
    assert_eq!(f.docs.snapshot(dirty.id).unwrap().text, "value=你!");
    f.docs.edit(dirty.id, f.docs.snapshot(dirty.id).unwrap().version, change(7, 8, "好")).unwrap();
    defaults.native_to_ascii = false;
    f.docs.set_file_defaults(defaults);
    f.docs.reload_properties();
    assert_eq!(f.docs.snapshot(clean.id).unwrap().text, r"value=\u4F60");
    assert!(f.docs.native_to_ascii_for(&paths[1]));
    f.docs.save(dirty.id).unwrap();
    assert_eq!(fs::read_to_string(&paths[1]).unwrap(), r"value=\u4F60\u597D");
}

#[test]
fn properties_ascii_noop_and_charset_conversion() {
    let f = fixture();
    let mut defaults = f.docs.file_defaults();
    defaults.native_to_ascii = true;
    f.docs.set_file_defaults(defaults);
    for (i, source) in ["a=b\r\n# comment\r\n", r"a=\u0041", r"a=\\u0041", r"a=\uD800"].iter().enumerate() {
        let path = f.root.join(format!("{i}.properties"));
        fs::write(&path, source).unwrap();
        let doc = f.docs.open(&path).unwrap();
        f.docs.edit(doc.id, doc.version, change(0, 0, "x")).unwrap();
        f.docs.edit(doc.id, doc.version + 1, change(0, 1, "")).unwrap();
        f.docs.save(doc.id).unwrap();
        f.docs.set_encoding(doc.id, "utf-8", true).unwrap();
        f.docs.save(doc.id).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), *source);
    }
    let path = f.root.join("utf16.properties");
    fs::write(&path, ide_vfs::encode("a=你好😀", "utf-16le", true).unwrap()).unwrap();
    let doc = f.docs.open(&path).unwrap();
    f.docs.replace_all(doc.id, "a=世界😀").unwrap();
    f.docs.save(doc.id).unwrap();
    assert!(fs::read(&path).unwrap().is_ascii());
    f.docs.set_encoding(doc.id, "utf-16le", true).unwrap();
    assert_eq!(f.docs.snapshot(doc.id).unwrap().text, "a=世界😀");
    assert!(!f.docs.is_dirty(doc.id).unwrap());
}
