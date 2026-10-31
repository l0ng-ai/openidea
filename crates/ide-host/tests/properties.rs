use ide_core::{ChangeSet, NullSink, RequestId, TextChange};
use ide_host::{
    Host, HostConfig,
    ops::{doc, search, vcs},
};
use ide_search::{SearchQuery, SearchScope};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};

fn git(root: &Path, args: &[&str]) {
    let out = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

fn host(base: &Path) -> Host {
    Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    })
}

async fn find(host: &Host, paths: Vec<PathBuf>, pattern: &str) -> Vec<ide_search::FileMatches> {
    let files = Arc::new(Mutex::new(Vec::new()));
    let found = files.clone();
    search::start(
        host,
        "main",
        RequestId(519),
        SearchQuery {
            pattern: pattern.into(),
            is_regex: false,
            case_sensitive: true,
            whole_word: false,
            include: Vec::new(),
            exclude: Vec::new(),
            scope: SearchScope::Files { paths: paths.into_iter().map(Into::into).collect() },
            max_matches: 0,
            context: Default::default(),
        },
        Arc::new(move |event| {
            if let search::SearchEvent::File { file } = event {
                found.lock().unwrap().push(file);
            }
        }),
    )
    .await
    .unwrap();
    Arc::try_unwrap(files).unwrap().into_inner().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn properties_search_git_and_document_coordinates_agree() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir(&root).unwrap();
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    git(&root, &["config", "commit.gpgsign", "false"]);
    git(&root, &["config", "core.autocrlf", "false"]);
    let path = root.join("messages.properties");
    let original = "hello=\\u4f60\\u597d\\uD83D\\uDE00target\nsecond=unchanged\nescaped=line\\u000Alogical\n";
    std::fs::write(&path, original).unwrap();
    let host = host(&base);
    let project = host.open_project("main", &root).unwrap();
    for _ in 0..500 {
        if !project.repos().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    git(&root, &["add", "."]);
    git(&root, &["commit", "-m", "Properties"]);
    let mut defaults = project.documents.file_defaults();
    defaults.native_to_ascii = true;
    project.documents.set_file_defaults(defaults);
    let displayed = "hello=你好😀target\nsecond=unchanged\nescaped=line\nlogical\n";
    assert_eq!(project.text_of(&path).unwrap(), displayed);
    let closed = find(&host, vec![path.clone()], "target").await;
    let closed_json = serde_json::to_value(&closed).unwrap();
    let opened = doc::open(&host, "main", path.clone()).await.unwrap();
    assert_eq!(opened.text, displayed);
    assert_eq!(serde_json::to_value(find(&host, vec![path.clone()], "target").await).unwrap(), closed_json);
    assert_eq!(closed[0].matches[0].ranges, vec![(10, 16)]);
    assert_eq!(find(&host, vec![path.clone()], "你好").await[0].matches.len(), 1);
    assert!(find(&host, vec![path.clone()], r"\u4f60").await.is_empty());
    assert!(vcs::vcs_line_hunks(&host, "main", path.clone()).await.unwrap().is_empty());
    assert_eq!(vcs::vcs_file_at(&host, "main", path.clone(), None).await.unwrap().as_deref(), Some(displayed));
    assert!(vcs::vcs_blame(&host, "main", path.clone(), None, None).await.unwrap().iter().all(|l| l.author == "Test"));
    doc::edit(
        &host,
        "main",
        opened.id,
        opened.version,
        ChangeSet { changes: vec![TextChange { from: 10, to: 16, insert: "世界".into() }] },
    )
    .unwrap();
    let hunks = vcs::vcs_line_hunks(&host, "main", path.clone()).await.unwrap();
    assert_eq!(hunks.len(), 1);
    assert_eq!(hunks[0].old_text, "hello=你好😀target\n");
    doc::save(&host, "main", opened.id).await.unwrap();
    let saved = std::fs::read(&path).unwrap();
    assert!(saved.is_ascii());
    assert!(String::from_utf8(saved.clone()).unwrap().contains(r"\u4F60\u597D\uD83D\uDE00\u4E16\u754C"));
    vcs::vcs_stage_hunks(&host, "main", path.clone(), vec![0]).await.unwrap();
    let repo = ide_vcs::Repo::discover(&root).unwrap().unwrap();
    assert_eq!(repo.file_bytes_at(&path, Some(":0")).unwrap().unwrap(), saved);
    repo.unstage(std::slice::from_ref(&path)).unwrap();
    // Line staging must match the decoded base even when Git stores lowercase escapes.
    let patch = ide_vcs::build_partial_patch("messages.properties", displayed, &project.text_of(&path).unwrap(), &[0]);
    repo.stage_patch(&patch, &|p| project.vcs_encoding(p, Some(":0"))).unwrap();
    assert_eq!(repo.file_bytes_at(&path, Some(":0")).unwrap().unwrap(), saved);
    repo.unstage(std::slice::from_ref(&path)).unwrap();
    let snap = project.documents.snapshot(opened.id).unwrap();
    project.documents.replace_all(opened.id, displayed).unwrap();
    doc::save(&host, "main", opened.id).await.unwrap();
    assert!(project.documents.snapshot(opened.id).unwrap().version > snap.version);
    assert!(vcs::vcs_line_hunks(&host, "main", path.clone()).await.unwrap().is_empty());
    // Partial commits identify hunks in displayed line coordinates as well.
    let partial_text = displayed.replace("target", "世界").replace("logical", "changed");
    project.documents.replace_all(opened.id, &partial_text).unwrap();
    doc::save(&host, "main", opened.id).await.unwrap();
    let hunks = ide_vcs::diff_hunks(displayed, &partial_text);
    assert_eq!(hunks.len(), 2);
    let selected = &hunks[0];
    let options = ide_vcs::CommitOptions {
        partial: vec![ide_vcs::PartialCommitFile {
            path: path.clone().into(),
            hunks: vec![ide_vcs::HunkRange {
                start: selected.start,
                lines: selected.lines,
                old_start: selected.old_start,
                old_lines: selected.old_lines,
            }],
        }],
        ..Default::default()
    };
    repo.commit_with("Selected properties change", &options, &|p| project.vcs_encoding(p, None)).unwrap();
    let head = vcs::vcs_file_at(&host, "main", path.clone(), None).await.unwrap().unwrap();
    assert_eq!(head, displayed.replace("target", "世界"));
    assert!(repo.file_bytes_at(&path, None).unwrap().unwrap().is_ascii());
    let closed_path = root.join("closed.properties");
    std::fs::write(&closed_path, r"value=\u4F60\u597D\uD83D\uDE00target").unwrap();
    let query = SearchQuery {
        pattern: "target".into(),
        is_regex: false,
        case_sensitive: true,
        whole_word: false,
        include: Vec::new(),
        exclude: Vec::new(),
        scope: SearchScope::Files { paths: vec![closed_path.clone().into()] },
        max_matches: 0,
        context: Default::default(),
    };
    search::replace_in_files(
        &host,
        "main",
        RequestId(520),
        query,
        "世界".into(),
        false,
        vec![ide_search::ReplaceTarget {
            path: closed_path.clone().into(),
            only: Some(vec![ide_core::Pos { line: 0, col: 10 }]),
        }],
        ide_host::ops::Channel::new(|_| {}),
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read_to_string(&closed_path).unwrap(), r"value=\u4F60\u597D\uD83D\uDE00\u4E16\u754C");
    assert!(project.documents.by_path(&closed_path).is_none());
    host.close_project("main");
}
