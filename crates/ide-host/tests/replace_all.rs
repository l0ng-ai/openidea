//! Replace All when the search hit its match limit (#4083): every match in the
//! scope is replaced, not just the listed ones.

use ide_core::{NullSink, Pos, RequestId};
use ide_host::{Host, HostConfig, ops};
use ide_search::{ReplaceEvent, ReplaceSummary, ReplaceTarget, SearchQuery};
use std::sync::{Arc, Mutex};

fn query(pattern: &str, is_regex: bool) -> SearchQuery {
    serde_json::from_value(serde_json::json!({"pattern": pattern, "isRegex": is_regex, "caseSensitive": true, "wholeWord": false, "include": [], "exclude": [], "scope": {"kind": "project"}, "maxMatches": 2000})).unwrap()
}

struct Case {
    name: &'static str,
    files: Vec<(&'static str, String)>,
    pattern: &'static str,
    is_regex: bool,
    replacement: &'static str,
    /// `(file, positions)` sent as targets: `skip` with `all_in_scope`, else `only`.
    targets: Vec<(&'static str, Vec<Pos>)>,
    all_in_scope: bool,
    expected: Vec<(&'static str, String)>,
    replaced: u32,
}

fn lines(n: usize, text: &str) -> String {
    format!("{text}\n").repeat(n)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replace_all_covers_matches_past_the_limit() {
    let cases = vec![
        Case {
            name: "one file, 2001 matches (the report)",
            files: vec![("repeated.txt", lines(2001, "CAP_PROBE"))],
            pattern: "CAP_PROBE",
            is_regex: false,
            replacement: "CAP_CHANGED",
            targets: vec![],
            all_in_scope: true,
            expected: vec![("repeated.txt", lines(2001, "CAP_CHANGED"))],
            replaced: 2001,
        },
        Case {
            name: "several files, unlisted ones too",
            files: vec![("a.txt", lines(1500, "CAP")), ("b.txt", lines(1500, "CAP")), ("sub/c.txt", "x CAP\n".into())],
            pattern: "CAP",
            is_regex: false,
            replacement: "Z",
            targets: vec![],
            all_in_scope: true,
            expected: vec![("a.txt", lines(1500, "Z")), ("b.txt", lines(1500, "Z")), ("sub/c.txt", "x Z\n".into())],
            replaced: 3001,
        },
        Case {
            name: "excluded usages are kept",
            files: vec![("repeated.txt", lines(2001, "CAP_PROBE"))],
            pattern: "CAP_PROBE",
            is_regex: false,
            replacement: "CAP_CHANGED",
            targets: vec![("repeated.txt", vec![Pos::new(0, 0), Pos::new(2000, 0)])],
            all_in_scope: true,
            expected: vec![("repeated.txt", format!("CAP_PROBE\n{}CAP_PROBE\n", lines(1999, "CAP_CHANGED")))],
            replaced: 1999,
        },
        Case {
            name: "regex with groups",
            files: vec![("repeated.txt", lines(2001, "CAP_PROBE"))],
            pattern: r"CAP_(\w+)",
            is_regex: true,
            replacement: "${1}_CAP",
            targets: vec![],
            all_in_scope: true,
            expected: vec![("repeated.txt", lines(2001, "PROBE_CAP"))],
            replaced: 2001,
        },
        Case {
            name: "Replace Selected keeps to the selected usages",
            files: vec![("repeated.txt", lines(3, "CAP_PROBE"))],
            pattern: "CAP_PROBE",
            is_regex: false,
            replacement: "CAP_CHANGED",
            targets: vec![("repeated.txt", vec![Pos::new(1, 0)])],
            all_in_scope: false,
            expected: vec![("repeated.txt", "CAP_PROBE\nCAP_CHANGED\nCAP_PROBE\n".into())],
            replaced: 1,
        },
    ];
    for case in cases {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let root = base.join("project");
        for (path, text) in &case.files {
            let path = root.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let host = Host::new(HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(NullSink)),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        });
        host.trust.decide(&root, true, false).unwrap();
        host.open_project("main", &root).unwrap();
        let targets = case
            .targets
            .iter()
            .map(|(path, at)| {
                let path = root.join(path).into();
                if case.all_in_scope {
                    ReplaceTarget { path, only: None, skip: Some(at.clone()) }
                } else {
                    ReplaceTarget { path, only: Some(at.clone()), skip: None }
                }
            })
            .collect();
        let summary = Arc::new(Mutex::new(ReplaceSummary::default()));
        let out = summary.clone();
        ops::search::replace_in_files(
            &host,
            "main",
            RequestId::next(),
            query(case.pattern, case.is_regex),
            case.replacement.into(),
            false,
            targets,
            case.all_in_scope,
            ops::Channel::new(move |e| {
                if let ReplaceEvent::Done { summary } = e {
                    *out.lock().unwrap() = summary;
                }
            }),
        )
        .await
        .unwrap();
        for (path, text) in &case.expected {
            assert_eq!(&std::fs::read_to_string(root.join(path)).unwrap(), text, "{}: {path}", case.name);
        }
        assert_eq!(summary.lock().unwrap().replacements, case.replaced, "{}", case.name);
        host.close_project("main");
    }
}

/// #4202: a file the search preview holds open (no unsaved changes) is saved like a closed
/// one; a buffer with unsaved edits is replaced in place and left for the editor to save.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replace_all_saves_open_buffers_without_unsaved_changes() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir_all(&root).unwrap();
    for name in ["previewed.txt", "edited.txt", "closed.txt"] {
        std::fs::write(root.join(name), "TOKEN\n").unwrap();
    }
    let host = Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
    let project = host.project("main").unwrap();
    project.documents.open(&root.join("previewed.txt")).unwrap();
    let edited = project.documents.open(&root.join("edited.txt")).unwrap().id;
    project.documents.replace_all(edited, "TOKEN\nmore\n").unwrap();
    ops::search::replace_in_files(
        &host,
        "main",
        RequestId::next(),
        query("TOKEN", false),
        "DONE".into(),
        false,
        vec![],
        true,
        ops::Channel::new(|_| {}),
    )
    .await
    .unwrap();
    let disk = |name: &str| std::fs::read_to_string(root.join(name)).unwrap();
    assert_eq!(disk("previewed.txt"), "DONE\n");
    assert_eq!(disk("closed.txt"), "DONE\n");
    assert_eq!(disk("edited.txt"), "TOKEN\n", "unsaved edits stay unsaved");
    assert_eq!(project.documents.text_snapshot(edited).unwrap().text, "DONE\nmore\n");
    host.close_project("main");
}
