use super::*;
use crate::{HostConfig, Project};
use ide_core::{IdeEvent, TextChange, event::NotifyLevel};
use parking_lot::Mutex;
use std::{path::Path, sync::Arc};

struct Fixture {
    host: Host,
    project: Arc<Project>,
    events: Arc<Mutex<Vec<IdeEvent>>>,
    path: PathBuf,
    outside: PathBuf,
    _temp: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let root = base.join("project");
        // Keep watcher delivery out of these tests: the op must recover it itself.
        let excluded = root.join("node_modules");
        std::fs::create_dir_all(&excluded).unwrap();
        let path = excluded.join("file.txt");
        let outside = base.join("outside.txt");
        std::fs::write(&path, "original\n").unwrap();
        std::fs::write(&outside, "outside\n").unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let host = Host::new(HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(move |_| {
                let events = captured.clone();
                Arc::new(move |event| events.lock().push(event))
            }),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        });
        let project = host.open_project("main", &root).unwrap();
        Self { _temp: temp, host, project, events, path, outside }
    }

    async fn open(&self, path: &Path) -> DocumentInfo {
        open(&self.host, "main", path.to_path_buf()).await.unwrap()
    }

    async fn sync(&self) {
        sync_from_disk(&self.host, "main").await.unwrap();
    }

    fn document_events(&self) -> Vec<IdeEvent> {
        self.events
            .lock()
            .iter()
            .filter(|e| matches!(e, IdeEvent::DocPatched { .. } | IdeEvent::DocDirty { .. } | IdeEvent::Notify { .. }))
            .cloned()
            .collect()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changed_clean_document_reloads_once() {
    let f = Fixture::new();
    let original = f.open(&f.path).await;
    std::fs::write(&f.path, "externally changed\n").unwrap();
    f.sync().await;
    let loaded = f.project.documents.snapshot(original.id).unwrap();
    assert_eq!(loaded.text, "externally changed\n");
    assert!(!loaded.dirty);
    assert!(loaded.version > original.version);
    f.events.lock().clear();
    f.sync().await;
    assert_eq!(f.project.documents.snapshot(original.id).unwrap().version, loaded.version);
    assert!(f.document_events().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unchanged_document_has_no_patch_or_event() {
    let f = Fixture::new();
    let original = f.open(&f.path).await;
    f.events.lock().clear();
    f.sync().await;
    let loaded = f.project.documents.snapshot(original.id).unwrap();
    assert_eq!(loaded.text, original.text);
    assert_eq!(loaded.version, original.version);
    assert!(f.document_events().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dirty_document_keeps_edits_and_warns_once() {
    let f = Fixture::new();
    let original = f.open(&f.path).await;
    edit(
        &f.host,
        "main",
        original.id,
        original.version,
        ChangeSet { changes: vec![TextChange { from: 0, to: 0, insert: "local ".into() }] },
    )
    .unwrap();
    f.events.lock().clear();
    std::fs::write(&f.path, "external replacement\n").unwrap();
    f.sync().await;
    let loaded = f.project.documents.snapshot(original.id).unwrap();
    assert_eq!(loaded.text, "local original\n");
    assert!(loaded.dirty);
    assert!(matches!(f.document_events().as_slice(), [IdeEvent::Notify { level: NotifyLevel::Warning, .. }]));
    f.events.lock().clear();
    f.sync().await;
    assert!(f.document_events().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleted_document_keeps_its_buffer_and_other_documents_still_reload() {
    let f = Fixture::new();
    let original = f.open(&f.path).await;
    let outside = f.open(&f.outside).await;
    std::fs::remove_file(&f.path).unwrap();
    std::fs::write(&f.outside, "outside changed after deletion\n").unwrap();
    f.sync().await;
    let loaded = f.project.documents.snapshot(original.id).unwrap();
    assert_eq!(loaded.text, original.text);
    assert_eq!(loaded.version, original.version);
    assert_eq!(f.project.documents.snapshot(outside.id).unwrap().text, "outside changed after deletion\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_project_document_reloads() {
    let f = Fixture::new();
    assert!(!f.outside.starts_with(&f.project.root));
    let original = f.open(&f.outside).await;
    std::fs::write(&f.outside, "outside changed externally\n").unwrap();
    f.sync().await;
    assert_eq!(f.project.documents.snapshot(original.id).unwrap().text, "outside changed externally\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn setting_defaults_on_and_disabled_sync_keeps_buffer() {
    let f = Fixture::new();
    assert!(f.project.settings.effective().files.sync_on_focus);
    assert!(serde_json::from_value::<ide_core::settings::FileSettings>(serde_json::json!({})).unwrap().sync_on_focus);
    let original = f.open(&f.outside).await;
    f.project.settings.set(ide_workspace::settings::SettingsScope::Project, "files.syncOnFocus", false.into()).unwrap();
    std::fs::write(&f.outside, "external change while disabled\n").unwrap();
    f.sync().await;
    assert_eq!(f.project.documents.snapshot(original.id).unwrap().version, original.version);
    f.project.settings.set(ide_workspace::settings::SettingsScope::Project, "files.syncOnFocus", true.into()).unwrap();
    f.sync().await;
    assert_eq!(f.project.documents.snapshot(original.id).unwrap().text, "external change while disabled\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn properties_reload_preserves_native_to_ascii_decoding() {
    let f = Fixture::new();
    let path = f.outside.with_extension("properties");
    std::fs::write(&path, "key=\\u4F60\n").unwrap();
    let mut defaults = f.project.documents.file_defaults();
    defaults.native_to_ascii = true;
    f.project.documents.set_file_defaults(defaults);
    let original = f.open(&path).await;
    assert_eq!(original.text, "key=你\n");
    std::fs::write(&path, "key=\\u4E16\\u754C\n").unwrap();
    f.sync().await;
    assert_eq!(f.project.documents.snapshot(original.id).unwrap().text, "key=世界\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn binary_and_virtual_documents_are_skipped() {
    let f = Fixture::new();
    let path = f.outside.with_extension("bin");
    std::fs::write(&path, b"\0\0binary payload").unwrap();
    let binary = f.open(&path).await;
    assert!(binary.read_only);
    let virtual_doc =
        f.project.documents.open_virtual("test://virtual", ide_core::LanguageId::plain_text(), "virtual").unwrap();
    std::fs::write(&path, "now ordinary text").unwrap();
    f.events.lock().clear();
    f.sync().await;
    assert_eq!(f.project.documents.snapshot(binary.id).unwrap().version, binary.version);
    assert_eq!(f.project.documents.snapshot(virtual_doc.id).unwrap().text, "virtual");
    assert!(f.document_events().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn synchronization_only_changes_the_calling_windows_documents() {
    let f = Fixture::new();
    let original = f.open(&f.outside).await;
    let other_root = f.outside.parent().unwrap().join("other-project");
    std::fs::create_dir(&other_root).unwrap();
    let other = f.host.open_project("other", &other_root).unwrap();
    let other_doc = open(&f.host, "other", f.outside.clone()).await.unwrap();
    std::fs::write(&f.outside, "external change in shared file\n").unwrap();
    f.sync().await;
    assert_eq!(f.project.documents.snapshot(original.id).unwrap().text, "external change in shared file\n");
    assert_eq!(other.documents.snapshot(other_doc.id).unwrap().text, other_doc.text);
}
