use ide_core::{NullSink, RequestId};
use ide_host::{Host, HostConfig, ops};
use std::sync::{Arc, Mutex};

async fn find(host: &Host, pattern: &str) -> Vec<ide_search::FileMatches> {
    let hits = Arc::new(Mutex::new(Vec::new()));
    let out = hits.clone();
    let query = serde_json::from_value(serde_json::json!({"pattern": pattern, "isRegex": false, "caseSensitive": false, "wholeWord": false, "include": [], "exclude": [], "scope": {"kind": "project"}, "maxMatches": 100})).unwrap();
    ops::search::start(
        host,
        "main",
        RequestId::next(),
        query,
        Arc::new(move |event| {
            if let ops::search::SearchEvent::File { file } = event {
                out.lock().unwrap().push(file);
            }
        }),
    )
    .await
    .unwrap();
    std::mem::take(&mut *hits.lock().unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn find_in_files_decodes_closed_files_with_the_project_encoding() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir(&root).unwrap();
    let text = "class CreditQuerySendUtils {\n    //中文搜索验证 Chinese Chinese Chinese\n}\n";
    std::fs::write(root.join("CreditQuerySendUtils.java"), ide_vfs::encode(text, "gbk", false).unwrap()).unwrap();
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
    let project = host.open_project("main", &root).unwrap();
    let mut defaults = project.documents.file_defaults();
    defaults.project_fallback = "gbk".into();
    project.documents.set_file_defaults(defaults);

    let files = find(&host, "中文搜索验证").await;
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].matches[0].text, "    //中文搜索验证 Chinese Chinese Chinese");
    assert_eq!(find(&host, "Chinese").await[0].matches[0].text, "    //中文搜索验证 Chinese Chinese Chinese");

    // The configured encoding is used rather than a guess.
    let mut defaults = project.documents.file_defaults();
    defaults.project_fallback = "big5".into();
    project.documents.set_file_defaults(defaults);
    assert!(find(&host, "中文搜索验证").await.is_empty());
}
