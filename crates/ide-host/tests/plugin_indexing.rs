//! Generic document-indexer contract through a minimal real WASM fixture.
use ide_core::{Pos, Range, SymbolKind};
use ide_host::plugins::navigation::Snapshot;
use ide_host::plugins::{Consent, PluginHost};
use ide_language::SymbolTag;
use ide_plugin::{Invocation, Limits};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    host: PluginHost,
}
impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let host = PluginHost::new(root.join("plugins"), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
        host.set_project_policy(Arc::new(|_| true));
        host.install_from_dir(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/indexer"),
            &Consent::all(),
        )
        .unwrap();
        Self { _tmp: tmp, root, host }
    }
    fn index(&self, path: &str, text: &str, symbols: &[SymbolTag], version: Option<u32>, scope: &str) -> PathBuf {
        let path = self.root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        self.host
            .index_navigation(
                &self.root,
                Snapshot { path: &path, version, text, symbols, scope },
                Invocation { workspace_root: Some(self.root.clone()), ..Default::default() },
            )
            .unwrap();
        path
    }
}
fn method() -> SymbolTag {
    SymbolTag {
        name: "item".into(),
        kind: SymbolKind::Method,
        container: None,
        range: Range::new(Pos::new(0, 4), Pos::new(0, 8)),
    }
}
const SOURCE: &str = "def source:item\nref mapping:item\n";
const MAPPING: &str = "def mapping:item\nref source:item\nsql SELECT 1\n";
fn reference_pos() -> Pos {
    Pos::new(1, 5)
}

#[test]
fn bidirectional_navigation_versions_and_incremental_deletion() {
    let f = Fixture::new();
    let source = f.index("src/source.idx", SOURCE, &[method()], Some(1), "app");
    let mapping = f.index("resources/mapping.idx", MAPPING, &[], Some(1), "app");
    let result = f.host.navigation_at(&f.root, &mapping, 1, reference_pos(), None, |_| None).unwrap();
    assert_eq!(result.targets[0].path.0, source);
    assert_eq!(result.range.end.col - result.range.start.col, 11);
    let reverse = f.host.navigation_at(&f.root, &source, 1, reference_pos(), None, |_| None).unwrap();
    assert_eq!(reverse.targets[0].path.0, mapping);
    assert!(f.host.navigation_at(&f.root, &mapping, 2, reference_pos(), None, |_| None).is_none());
    assert!(f.host.navigation_at(&f.root, &mapping, 1, reference_pos(), None, |_| Some(2)).is_none());
    f.host.invalidate_navigation(&f.root, Some(&[source]));
    assert!(f.host.navigation_at(&f.root, &mapping, 1, reference_pos(), None, |_| None).is_none());
}

#[test]
fn module_candidates_reload_disable_and_project_isolation() {
    let f = Fixture::new();
    let first = f.index("a/source.idx", SOURCE, &[method()], Some(1), "a");
    f.index("b/source.idx", SOURCE, &[method()], Some(1), "b");
    let mapping = f.index("a/mapping.idx", MAPPING, &[], Some(1), "a");
    let result = f.host.navigation_at(&f.root, &mapping, 1, reference_pos(), None, |_| None).unwrap();
    assert_eq!(result.targets.len(), 1);
    assert_eq!(result.targets[0].path.0, first);
    let other = f.index("c/mapping.idx", MAPPING, &[], Some(1), "c");
    assert_eq!(f.host.navigation_at(&f.root, &other, 1, reference_pos(), None, |_| None).unwrap().targets.len(), 2);
    assert!(
        f.host.navigation_at(&f.root.join("other-project"), &mapping, 1, reference_pos(), None, |_| None).is_none()
    );
    f.host.set_enabled("test.indexer", false).unwrap();
    assert!(f.host.navigation_at(&f.root, &mapping, 1, reference_pos(), None, |_| None).is_none());
    f.host.set_enabled("test.indexer", true).unwrap();
    assert!(f.host.navigation_at(&f.root, &mapping, 1, reference_pos(), None, |_| None).is_none());
    f.host.reload("test.indexer").unwrap();
    assert!(f.host.navigation_at(&f.root, &mapping, 1, reference_pos(), None, |_| None).is_none());
}

#[test]
fn warmed_clicks_never_read_or_parse_files() {
    let f = Fixture::new();
    let source = f.index("source.idx", SOURCE, &[method()], Some(1), "");
    let mapping = f.index("mapping.idx", MAPPING, &[], Some(1), "");
    // Files become unreadable; the watcher invalidates separately. Resolution
    // must remain purely in-memory, with no disk reads or component execution.
    std::fs::remove_file(&source).unwrap();
    std::fs::remove_file(&mapping).unwrap();
    let calls = f.host.info_of("test.indexer").unwrap().stats.calls;
    for _ in 0..10_000 {
        assert_eq!(
            f.host.navigation_at(&f.root, &mapping, 1, reference_pos(), None, |_| None).unwrap().targets.len(),
            1
        );
    }
    assert_eq!(f.host.info_of("test.indexer").unwrap().stats.calls, calls, "warm navigation must not execute Wasm");
    f.host.invalidate_navigation(&f.root, None);
    assert!(f.host.navigation_at(&f.root, &mapping, 1, reference_pos(), None, |_| None).is_none());
}

#[test]
fn permissions_and_paths_are_checked_before_indexing() {
    let f = Fixture::new();
    let external = tempfile::NamedTempFile::new().unwrap();
    assert!(
        f.host
            .index_navigation(
                &f.root,
                Snapshot { path: external.path(), version: None, text: "", symbols: &[], scope: "" },
                Invocation::default()
            )
            .is_err()
    );
    f.host.set_project_policy(Arc::new(|_| false));
    assert!(f.host.navigation_extensions(&f.root).is_empty());
    assert!(
        f.host
            .index_navigation(
                &f.root,
                Snapshot { path: &f.root.join("x.idx"), version: None, text: MAPPING, symbols: &[], scope: "" },
                Invocation::default()
            )
            .is_err()
    );
}

#[test]
fn syntax_symbols_aliases_and_utf16_ranges_cross_the_wasm_boundary() {
    let f = Fixture::new();
    let symbol = method();
    let definition = f.index("source.idx", "def item\nsymbols parent#\n", &[symbol], Some(1), "app");
    f.index("child.idx", "alias child# parent#\n", &[], Some(1), "app");
    let mapping = f.index("mapping.idx", "ref child#item\n", &[], Some(1), "app");
    let result = f.host.navigation_at(&f.root, &mapping, 1, Pos::new(0, 6), None, |_| None).unwrap();
    assert_eq!(result.targets[0].path.0, definition);
    assert_eq!(result.targets[0].range, method().range);
    f.index("unicode.idx", "def 😀\n", &[], Some(1), "app");
    let unicode = f.index("unicode-ref.idx", "ref 😀\n", &[], Some(1), "app");
    let result = f.host.navigation_at(&f.root, &unicode, 1, Pos::new(0, 5), None, |_| None).unwrap();
    assert_eq!(result.range, Range::new(Pos::new(0, 4), Pos::new(0, 6)));
}

#[test]
fn two_windows_of_same_root_keep_unsaved_snapshots_isolated() {
    let f = Fixture::new();
    let source = f.index("source.idx", SOURCE, &[method()], Some(1), "");
    let mapping = f.index("mapping.idx", MAPPING, &[], Some(1), "");
    for client in ["one", "two"] {
        let mut symbol = method();
        if client == "two" {
            symbol.range = Range::new(Pos::new(0, 5), Pos::new(0, 9));
        }
        for (path, text, symbols) in [(&source, "symbols source:\n", vec![symbol]), (&mapping, MAPPING, vec![])] {
            f.host
                .index_navigation(
                    &f.root,
                    Snapshot { path, version: Some(1), text, symbols: &symbols, scope: "" },
                    Invocation { client: Some(client.into()), workspace_root: Some(f.root.clone()), editor: None },
                )
                .unwrap();
        }
    }
    assert_eq!(
        f.host.navigation_at(&f.root, &mapping, 1, reference_pos(), Some("one"), |_| None).unwrap().targets[0]
            .range
            .start
            .col,
        4
    );
    assert_eq!(
        f.host.navigation_at(&f.root, &mapping, 1, reference_pos(), Some("two"), |_| None).unwrap().targets[0]
            .range
            .start
            .col,
        5
    );
    f.host.invalidate_client_navigation(&f.root, Some("one"), None);
    assert!(f.host.navigation_at(&f.root, &mapping, 1, reference_pos(), Some("one"), |_| None).is_none());
    assert!(f.host.navigation_at(&f.root, &mapping, 1, reference_pos(), Some("two"), |_| None).is_some());
}

#[test]
fn presentation_icons_markers_and_disable_follow_graph_state() {
    let f = Fixture::new();
    let tags = vec![];
    let source = f.index("source.idx", SOURCE, &tags, Some(1), "app");
    assert!(f.host.navigation_presentations(&f.root, std::slice::from_ref(&source), None, |_| None).is_empty());
    let mapping = f.index("mapping.idx", MAPPING, &[], Some(1), "app");
    let entries = f.host.navigation_presentations(&f.root, &[source.clone(), mapping.clone()], None, |_| None);
    let source_ui = entries.iter().find(|e| e.path == source).unwrap();
    assert_eq!(source_ui.icon.as_deref(), Some("ext:fileIcon/test.indexer/mapping"));
    assert_eq!(source_ui.markers.len(), 1);
    let mapping_ui = entries.iter().find(|e| e.path == mapping).unwrap();
    assert_eq!(mapping_ui.icon.as_deref(), Some("ext:fileIcon/test.indexer/mapping"));
    assert_eq!(mapping_ui.markers.len(), 1);
    assert_eq!(mapping_ui.regions.len(), 1);
    assert!(f.host.navigation_presentations(&f.root, std::slice::from_ref(&source), None, |_| Some(2)).is_empty());
    f.host.invalidate_navigation(&f.root, Some(&[mapping]));
    assert!(f.host.navigation_presentations(&f.root, std::slice::from_ref(&source), None, |_| None).is_empty());
    f.host.set_enabled("test.indexer", false).unwrap();
    assert!(f.host.navigation_presentations(&f.root, &[source], None, |_| None).is_empty());
}

#[test]
fn invalid_ranges_and_oversized_documents_never_publish() {
    let f = Fixture::new();
    let path = f.root.join("invalid.idx");
    std::fs::write(&path, "invalid key\n").unwrap();
    for text in ["invalid key\n".to_owned(), "x".repeat(ide_host::plugins::navigation::MAX_DOCUMENT_BYTES + 1)] {
        assert!(
            f.host
                .index_navigation(
                    &f.root,
                    Snapshot { path: &path, version: Some(1), text: &text, symbols: &[], scope: "" },
                    Invocation { workspace_root: Some(f.root.clone()), ..Default::default() },
                )
                .is_err()
        );
    }
    assert!(f.host.navigation_presentations(&f.root, &[path], None, |_| None).is_empty());
}
