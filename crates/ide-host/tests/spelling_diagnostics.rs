//! The Typo check publishes what it finds as a diagnostics event, like every other producer.
use ide_core::{IdeEvent, RequestId};
use ide_host::{Host, HostConfig};
use ide_spell::SpellScope;
use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::Arc;

struct Events(Arc<Mutex<Vec<IdeEvent>>>);

impl ide_core::EventSink for Events {
    fn emit(&self, event: IdeEvent) {
        self.0.lock().push(event);
    }
}

struct Harness {
    host: Arc<Host>,
    root: PathBuf,
    events: Arc<Mutex<Vec<IdeEvent>>>,
    _tmp: tempfile::TempDir,
}

impl Harness {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
        let sink = events.clone();
        let host = Arc::new(Host::new(HostConfig {
            config_dir: tmp.path().join("config"),
            data_dir: tmp.path().join("data"),
            local_data_dir: tmp.path().join("local"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(move |_| Arc::new(Events(sink.clone()))),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        }));
        host.open_project("main", &root).unwrap();
        Self { host, root, events, _tmp: tmp }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_spelling_check_publishes_a_diagnostics_event() {
    let f = Harness::new();
    let path = f.root.join("notes.txt");
    // `Recieve` and `mesage` are in the bundled dictionary's misspelling list.
    std::fs::write(&path, "Recieve the mesage from the server\n").unwrap();
    let project = f.host.project("main").unwrap();
    let doc = project.documents.open(&path).unwrap();
    let typos = ide_host::ops::spell::spell_check(&f.host, "main", doc.id, SpellScope::default(), RequestId::next())
        .await
        .unwrap();
    assert_eq!(typos.iter().map(|t| t.word.as_str()).collect::<Vec<_>>(), ["Recieve", "mesage"]);

    let events = f.events.lock();
    let published = events
        .iter()
        .find_map(|e| match e {
            IdeEvent::Diagnostics { path: p, source, items } if source == "Spelling" => {
                Some((p.clone(), items.clone()))
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("no diagnostics event was published: {events:?}"));
    assert_eq!(ide_core::ipc_path::to_ipc(&published.0.0), ide_core::ipc_path::to_ipc(&path));
    assert_eq!(published.1.len(), 2);
    assert_eq!(published.1[0].message, "Typo: In word 'Recieve'");
}
