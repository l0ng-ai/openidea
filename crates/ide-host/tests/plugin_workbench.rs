use ide_core::{CancellationToken, Diagnostic, Pos, Range, Severity};
use ide_host::plugins::{HostWorkspace, PluginWorkspace};
use ide_host::{Host, HostConfig};
use ide_plugin::TextQuery;
use std::path::PathBuf;
use std::sync::Arc;

struct Harness {
    host: Arc<Host>,
    root: PathBuf,
    _tmp: tempfile::TempDir,
}
impl Harness {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let host = Arc::new(Host::new(HostConfig {
            config_dir: tmp.path().join("config"),
            data_dir: tmp.path().join("data"),
            local_data_dir: tmp.path().join("local"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(ide_core::NullSink)),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        }));
        host.open_project("main", &root).unwrap();
        host.open_project("second", &root).unwrap();
        Self { host, root, _tmp: tmp }
    }
    fn workspace(&self) -> HostWorkspace {
        HostWorkspace(Arc::downgrade(&self.host))
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn window_editor_reports_use_document_language_dirty_state_and_focus() {
    let f = Harness::new();
    let path = f.root.join("main.rs");
    std::fs::write(&path, "fn main() {}\n").unwrap();
    let p = f.host.project("main").unwrap();
    let doc = p.documents.open(&path).unwrap();
    p.documents
        .apply_edits(doc.id, &[ide_core::TextEdit { range: Range::default(), new_text: "// unsaved\n".into() }])
        .unwrap();
    f.host.mcp_reports.set_open_editors("main", vec![path.clone()]);
    f.host.mcp_reports.set_focused_editor(
        "main",
        Some(ide_host::mcp::FocusedEditor {
            path: path.clone().into(),
            selection: Range::default(),
            selected_text: String::new(),
        }),
        true,
    );
    let workspace = f.workspace();
    let editors = workspace.open_editors("main").unwrap();
    assert_eq!(editors.len(), 1);
    assert!(editors[0].dirty && editors[0].active);
    assert_eq!(editors[0].language, "rust");
    assert!(workspace.open_editors("second").unwrap().is_empty());
    let second = f.host.project("second").unwrap();
    second.documents.open(&path).unwrap();
    f.host.mcp_reports.set_open_editors("second", vec![path.clone()]);
    assert!(!workspace.open_editors("second").unwrap()[0].dirty);
    assert!(workspace.open_editors("main").unwrap()[0].dirty);
    assert!(workspace.buffer_text_in(Some("main"), &path).unwrap().contains("unsaved"));
    assert!(!workspace.buffer_text_in(Some("second"), &path).unwrap().contains("unsaved"));
    assert_ne!(workspace.document_in("main", &path), workspace.document_in("second", &path));
    f.host.mcp_reports.forget_window("main");
    assert!(workspace.open_editors("main").unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn text_search_uses_overlay_excludes_utf16_and_limits() {
    let f = Harness::new();
    let path = f.root.join("a.txt");
    std::fs::write(&path, "disk\n").unwrap();
    std::fs::create_dir(f.root.join("target")).unwrap();
    std::fs::write(f.root.join("target/ignored.txt"), "needle").unwrap();
    let p = f.host.project("main").unwrap();
    p.settings
        .set(ide_workspace::settings::SettingsScope::Project, "files.ignoredNames", serde_json::json!(["target"]))
        .unwrap();
    let doc = p.documents.open(&path).unwrap();
    p.documents
        .apply_edits(doc.id, &[ide_core::TextEdit { range: Range::default(), new_text: "😀needle\nneedle\n".into() }])
        .unwrap();
    f.host.project("second").unwrap().documents.open(&path).unwrap();
    let workspace = f.workspace();
    let query = TextQuery { pattern: "needle".into(), case_sensitive: true, ..Default::default() };
    let found = workspace.search_text(Some("main"), &f.root, query.clone(), 10, &CancellationToken::new()).unwrap();
    assert_eq!(found.matches.len(), 2, "{found:?}; text={:?}", workspace.buffer_text(&path));
    assert_eq!(found.matches[0].location.range, Range::new(Pos::new(0, 2), Pos::new(0, 8)));
    assert!(found.matches.iter().all(|m| m.location.path == path));
    let only_file = TextQuery { include: vec!["a.txt".into()], ..query.clone() };
    assert!(
        workspace
            .search_text(Some("second"), &f.root, only_file, 10, &CancellationToken::new())
            .unwrap()
            .matches
            .is_empty()
    );
    let capped = workspace.search_text(Some("main"), &f.root, query.clone(), 1, &CancellationToken::new()).unwrap();
    assert_eq!(capped.matches.len(), 1);
    assert!(capped.limit_hit);
    let excluded = TextQuery { exclude: vec!["*.txt".into()], ..query.clone() };
    assert!(
        workspace
            .search_text(Some("main"), &f.root, excluded, 10, &CancellationToken::new())
            .unwrap()
            .matches
            .is_empty()
    );
    for query in [
        TextQuery { pattern: "NEEDLE".into(), case_sensitive: true, ..Default::default() },
        TextQuery { pattern: "need".into(), whole_word: true, ..Default::default() },
        TextQuery { include: vec!["*.rs".into()], ..query.clone() },
    ] {
        assert!(
            workspace
                .search_text(Some("main"), &f.root, query, 10, &CancellationToken::new())
                .unwrap()
                .matches
                .is_empty()
        );
    }
    let multiline = TextQuery { pattern: "needle\nneedle".into(), regex: true, ..Default::default() };
    let found = workspace.search_text(Some("main"), &f.root, multiline, 10, &CancellationToken::new()).unwrap();
    assert_eq!(found.matches[0].location.range, Range::new(Pos::new(0, 2), Pos::new(1, 6)));
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(matches!(
        workspace.search_text(Some("main"), &f.root, query, 10, &cancelled),
        Err(ide_plugin::HostError::Cancelled)
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn problems_share_project_reports_and_keep_sources_separate() {
    let f = Harness::new();
    let path = f.root.join("a.txt");
    std::fs::write(&path, "text").unwrap();
    let diagnostic = |source: &str| Diagnostic {
        range: Range::default(),
        severity: Severity::Warning,
        message: source.into(),
        source: Some(source.into()),
        code: None,
        unnecessary: false,
        deprecated: false,
        server: None,
    };
    f.host.mcp_reports.report_problems(
        "second",
        true,
        vec![ide_host::mcp::FileProblems {
            path: path.clone().into(),
            items: vec![diagnostic("lsp"), diagnostic("plugin")],
        }],
    );
    let workspace = f.workspace();
    let files = workspace.problems("main", Some(&path)).unwrap();
    assert_eq!(files.len(), 2);
    assert!(files.iter().all(|f| f.diagnostics.len() == 1));
    assert!(workspace.problems("main", Some(&f.root.join("other.txt"))).unwrap().is_empty());
    f.host.mcp_reports.forget_window("second");
    assert!(workspace.problems("main", None).unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn search_decodes_closed_documents_the_same_way_as_the_editor() {
    let f = Harness::new();
    let path = f.root.join("utf16.txt");
    let mut bytes = vec![0xff, 0xfe];
    for unit in "😀needle\r\n".encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    std::fs::write(&path, bytes).unwrap();
    let query = TextQuery { pattern: "needle".into(), ..Default::default() };
    let result = f.workspace().search_text(Some("main"), &f.root, query, 10, &CancellationToken::new()).unwrap();
    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.matches[0].location.range, Range::new(Pos::new(0, 2), Pos::new(0, 8)));
    assert_eq!(result.matches[0].line, "😀needle");
}
