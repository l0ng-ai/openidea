use ide_core::{ChangeSet, NullSink, TextChange};
use ide_host::{Host, HostConfig, ops::vcs};
use std::{path::Path, process::Command, sync::Arc, time::Duration};

fn git(root: &Path, args: &[&str]) {
    let out = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gbk_document_gutter_diff_stage_and_rollback_share_encoding() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir(&root).unwrap();
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    git(&root, &["config", "commit.gpgsign", "false"]);
    git(&root, &["config", "core.autocrlf", "false"]);
    let path = root.join("Example.java");
    let old = "// 中文注释\nclass Example {\n    // 保持不变\n    int value = 1;\n}\n";
    let original = ide_vfs::encode(old, "gbk", false).unwrap();
    std::fs::write(&path, &original).unwrap();
    std::fs::write(root.join("Utf8.java"), old).unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-m", "GBK Java"]);
    let host = Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    let project = host.open_project("main", &root).unwrap();
    for _ in 0..500 {
        if !project.repos().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let mut defaults = project.documents.file_defaults();
    defaults.project_fallback = "gbk".into();
    project.documents.set_file_defaults(defaults);
    assert_eq!(project.text_of(&path).unwrap(), old);
    assert_eq!(vcs::vcs_file_at(&host, "main", path.clone(), None).await.unwrap().as_deref(), Some(old));
    let doc = project.documents.open(&path).unwrap();
    assert_eq!(doc.encoding, "gbk");
    // A live document's explicit selection wins over later project defaults.
    let mut defaults = project.documents.file_defaults();
    defaults.project_fallback = "windows-1252".into();
    project.documents.set_file_defaults(defaults);
    assert!(vcs::vcs_line_hunks(&host, "main", path.clone()).unwrap().is_empty());
    let from = old.find("value = 1").unwrap() + "value = ".len();
    let offset = old[..from].encode_utf16().count() as u32;
    project
        .documents
        .edit(
            doc.id,
            doc.version,
            ChangeSet { changes: vec![TextChange { from: offset, to: offset + 1, insert: "2".into() }] },
        )
        .unwrap();
    let hunks = vcs::vcs_line_hunks(&host, "main", path.clone()).unwrap();
    assert_eq!(hunks.len(), 1);
    assert_eq!((hunks[0].start, hunks[0].lines), (3, 1));
    assert_eq!(hunks[0].old_text, "    int value = 1;\n");
    project.documents.save(doc.id).unwrap();
    vcs::vcs_stage_hunks(&host, "main", path.clone(), vec![0]).unwrap();
    let repo = ide_vcs::Repo::discover(&root).unwrap().unwrap();
    assert_eq!(
        repo.file_bytes_at(&path, Some(":0")).unwrap().unwrap(),
        ide_vfs::encode(&old.replace("value = 1", "value = 2"), "gbk", false).unwrap()
    );
    repo.unstage(std::slice::from_ref(&path)).unwrap();
    let snapshot = project.documents.snapshot(doc.id).unwrap();
    let line_start =
        snapshot.text.split_inclusive('\n').take(3).map(|s| s.encode_utf16().count()).sum::<usize>() as u32;
    project
        .documents
        .edit(
            doc.id,
            snapshot.version,
            ChangeSet {
                changes: vec![TextChange {
                    from: line_start,
                    to: line_start + "    int value = 2;\n".encode_utf16().count() as u32,
                    insert: hunks[0].old_text.clone(),
                }],
            },
        )
        .unwrap();
    project.documents.save(doc.id).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), original);
    assert!(vcs::vcs_line_hunks(&host, "main", path.clone()).unwrap().is_empty());
    assert!(vcs::vcs_blame(&host, "main", path.clone(), None).await.unwrap().iter().all(|l| l.author == "Test"));
    // Missing working files still use configured encoding for historical content.
    project.documents.close(doc.id);
    let mut defaults = project.documents.file_defaults();
    defaults.project_fallback = "gbk".into();
    project.documents.set_file_defaults(defaults);
    std::fs::remove_file(&path).unwrap();
    assert_eq!(vcs::vcs_file_at(&host, "main", path, None).await.unwrap().as_deref(), Some(old));
    let utf8 = root.join("Utf8.java");
    std::fs::remove_file(&utf8).unwrap();
    assert_eq!(vcs::vcs_file_at(&host, "main", utf8, None).await.unwrap().as_deref(), Some(old));
    host.close_project("main");
}
