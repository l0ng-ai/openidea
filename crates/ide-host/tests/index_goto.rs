//! `indexGoto`: the project index's navigation fallback on the vue-app
//! fixture — the import chain (relative, alias, re-export), a `<script>`
//! region's locals, and the component registry (docs/vue-ts-semantic-index.md).

use ide_core::{DocId, NullSink, Pos};
use ide_host::ops::nav::{IndexGoto, IndexNote};
use ide_host::{Host, HostConfig, ops};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

fn host(base: &Path) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }))
}

/// The position of `needle`'s `nth` (0-based) occurrence, in UTF-16 columns.
fn pos_of(text: &str, needle: &str, nth: usize) -> Pos {
    let mut seen = 0;
    for (line, l) in text.lines().enumerate() {
        let mut from = 0;
        while let Some(i) = l[from..].find(needle) {
            if seen == nth {
                let col = l[..from + i].encode_utf16().count() as u32;
                return Pos::new(line as u32, col);
            }
            seen += 1;
            from += i + needle.len();
        }
    }
    panic!("{needle} #{nth} not found");
}

/// Copies the fixture into a temp dir (kept for the test's lifetime), opens
/// it as a project and waits for the index, then opens `relative`.
async fn opened(relative: &str) -> (Arc<Host>, PathBuf, DocId, String) {
    let root = dunce::canonicalize(tempfile::tempdir().unwrap().keep()).unwrap();
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/vue-app");
    copy_dir(&fixture, &root);
    let host = host(&root.join("app"));
    host.open_project("main", &root).unwrap();
    let project = host.project("main").unwrap();
    assert!(project.index.wait_idle(Duration::from_secs(30)), "indexing finishes");

    let path = root.join(relative);
    let text = std::fs::read_to_string(&path).unwrap();
    let doc = ops::doc::open(&host, "main", path).await.unwrap();
    (host, root, doc.id, text)
}

fn copy_dir(from: &Path, to: &Path) {
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            std::fs::create_dir_all(&target).unwrap();
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

async fn goto(host: &Host, doc: DocId, pos: Pos, word: &str) -> Option<IndexGoto> {
    ops::nav::index_goto(host, "main", doc, pos, word.to_string()).await.unwrap()
}

fn path_of(hit: &IndexGoto) -> PathBuf {
    PathBuf::from(hit.targets[0].path.clone())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resolves_the_import_chain_and_component_tags() {
    let (host, root, doc, text) = opened("src/App.vue").await;

    // The component tag in the template → the component's file.
    let hit = goto(&host, doc, pos_of(&text, "UserCard", 0), "UserCard").await.unwrap();
    assert_eq!(hit.note, IndexNote::Certain);
    assert_eq!(path_of(&hit), root.join("src/components/UserCard.vue"));

    // An alias import (`@/composables/useAuth`) → the exported declaration.
    let hit = goto(&host, doc, pos_of(&text, "useAuth()", 0), "useAuth").await.unwrap();
    assert_eq!(path_of(&hit), root.join("src/composables/useAuth.ts"));
    assert_eq!(hit.targets[0].range.start.line, 0, "the `useAuth` declaration");

    // A re-export (`./api` re-exports `client`'s `get`) → the origin module.
    let hit = goto(&host, doc, pos_of(&text, "get('/x')", 0), "get").await.unwrap();
    assert_eq!(path_of(&hit), root.join("src/api/client.ts"));

    // A local of the <script> region → its in-file definition.
    let hit = goto(&host, doc, pos_of(&text, "auth", 0), "auth").await.unwrap();
    assert_eq!(path_of(&hit), root.join("src/App.vue"));
    assert_eq!(hit.targets[0].range.start.line, pos_of(&text, "const auth", 0).line);

    // A bare package specifier stays unresolved (node_modules is the
    // language servers' territory).
    assert!(goto(&host, doc, pos_of(&text, "ref(null)", 0), "ref").await.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resolves_default_imports_and_the_component_registry() {
    let (host, root, doc, text) = opened("src/main.ts").await;

    // `import App from './App.vue'` → the component's file.
    let hit = goto(&host, doc, pos_of(&text, "App)", 0), "App").await.unwrap();
    assert_eq!(hit.note, IndexNote::Certain);
    assert_eq!(path_of(&hit), root.join("src/App.vue"));

    // A kebab-case tag without an import (unplugin-style auto-import) → the
    // registry's file-name match, labelled `candidate`.
    let (vhost, vroot, vdoc, _vtext) = opened("src/App.vue").await;
    let hit = goto(&vhost, vdoc, Pos::new(0, 1), "user-card").await.unwrap();
    assert_eq!(hit.note, IndexNote::Candidate);
    assert_eq!(path_of(&hit), vroot.join("src/components/UserCard.vue"));
}
