use ide_core::{ChangeSet, NullSink, TextChange};
use ide_host::{Host, HostConfig, Project, ops::vcs};
use std::{path::Path, process::Command, sync::Arc, time::Duration};

const ORIGINAL: &str = "SELECT *\nFROM patients\n\tLIMIT 10 OFFSET 0";
const OTHER: &str = "SELECT id\nFROM patients\n\tLIMIT 20 OFFSET 0";

fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

struct Fixture {
    host: Host,
    project: Arc<Project>,
    path: std::path::PathBuf,
    doc: ide_core::DocId,
    _temp: tempfile::TempDir,
}

impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let root = base.join("project");
        // The command must synchronize documents even when watcher delivery is excluded.
        let path = root.join("node_modules/query.sql");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "user.name", "Test"]);
        git(&root, &["config", "user.email", "test@example.com"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        std::fs::write(&path, ORIGINAL).unwrap();
        git(&root, &["add", "-f", "node_modules/query.sql"]);
        git(&root, &["commit", "-m", "original"]);
        git(&root, &["switch", "-c", "other"]);
        std::fs::write(&path, OTHER).unwrap();
        git(&root, &["commit", "-am", "other"]);
        git(&root, &["switch", "main"]);
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
        for _ in 0..500 {
            if !project.repos().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let doc = project.documents.open(&path).unwrap().id;
        Self { host, project, path, doc, _temp: temp }
    }

    fn saved_edit(&self, text: &str) {
        self.project.documents.replace_all(self.doc, text).unwrap();
        self.project.documents.save(self.doc).unwrap();
    }

    fn assert_clean(&self, text: &str) {
        let snapshot = self.project.documents.snapshot(self.doc).unwrap();
        assert_eq!(snapshot.text, text);
        assert!(!snapshot.dirty);
        self.project.documents.save_all().unwrap();
        assert_eq!(std::fs::read_to_string(&self.path).unwrap(), text);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.host.close_project("main");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkout_reloads_clean_open_documents_before_returning() {
    let f = Fixture::new().await;
    vcs::vcs_checkout(&f.host, "main", None, "other".into(), false, None).await.unwrap();
    f.assert_clean(OTHER);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rollback_reloads_clean_open_documents_before_returning() {
    let f = Fixture::new().await;
    f.saved_edit(&format!("{ORIGINAL}\n"));
    vcs::vcs_discard(&f.host, "main", vec![f.path.clone()]).await.unwrap();
    f.assert_clean(ORIGINAL);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stash_and_unstash_reload_clean_open_documents_before_returning() {
    let f = Fixture::new().await;
    let edited = format!("{ORIGINAL}\n");
    f.saved_edit(&edited);
    vcs::vcs_stash_push(&f.host, "main", None, None, false, false).await.unwrap();
    f.assert_clean(ORIGINAL);
    vcs::vcs_stash_apply(&f.host, "main", None, 0, true, false, None).await.unwrap();
    f.assert_clean(&edited);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn applying_patch_reloads_clean_open_documents_before_returning() {
    let f = Fixture::new().await;
    std::fs::write(&f.path, OTHER).unwrap();
    let patch = git(&f.project.root, &["diff"]);
    git(&f.project.root, &["restore", "."]);
    vcs::vcs_apply_patch(&f.host, "main", None, patch).await.unwrap();
    f.assert_clean(OTHER);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn writing_patch_file_reloads_its_clean_open_document() {
    let f = Fixture::new().await;
    vcs::vcs_write_patch(&f.host, "main", f.path.clone(), OTHER.into()).await.unwrap();
    f.assert_clean(OTHER);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn directory_compare_overwrite_reloads_clean_open_documents() {
    let f = Fixture::new().await;
    let base = f.project.root.parent().unwrap();
    let source = base.join("source");
    let destination = base.join("destination");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::create_dir_all(&destination).unwrap();
    std::fs::write(source.join("query.sql"), OTHER).unwrap();
    let path = destination.join("query.sql");
    std::fs::write(&path, ORIGINAL).unwrap();
    let doc = f.project.documents.open(&path).unwrap();
    ide_host::ops::fs::copy_merge(&f.host, "main", source, destination, "query.sql".into(), true).await.unwrap();
    let snapshot = f.project.documents.snapshot(doc.id).unwrap();
    assert_eq!(snapshot.text, OTHER);
    assert!(!snapshot.dirty);
    f.project.documents.save_all().unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), OTHER);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_working_tree_operation_synchronizes_partial_disk_changes() {
    let f = Fixture::new().await;
    let result: ide_core::IdeResult<()> = f.project.with_repo_recorded(None, Some("Git merge"), |_| {
        std::fs::write(&f.path, OTHER).unwrap();
        Err(ide_core::IdeError::invalid("merge stopped with conflicts"))
    });
    assert!(result.is_err());
    f.assert_clean(OTHER);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn working_tree_operation_reloads_same_size_same_timestamp_changes() {
    let f = Fixture::new().await;
    let modified = std::fs::metadata(&f.path).unwrap().modified().unwrap();
    let replacement = ORIGINAL.replace("LIMIT 10", "LIMIT 20");
    f.project
        .with_repo_recorded(None, Some("Git checkout"), |_| {
            std::fs::write(&f.path, &replacement).unwrap();
            std::fs::File::options()
                .write(true)
                .open(&f.path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(modified))
                .unwrap();
            Ok(())
        })
        .unwrap();
    f.assert_clean(&replacement);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn working_tree_operation_does_not_discard_unsaved_edits() {
    let f = Fixture::new().await;
    let version = f.project.documents.snapshot(f.doc).unwrap().version;
    f.project
        .documents
        .edit(f.doc, version, ChangeSet { changes: vec![TextChange { from: 0, to: 0, insert: "-- local\n".into() }] })
        .unwrap();
    vcs::vcs_checkout(&f.host, "main", None, "other".into(), false, None).await.unwrap();
    let snapshot = f.project.documents.snapshot(f.doc).unwrap();
    assert_eq!(snapshot.text, format!("-- local\n{ORIGINAL}"));
    assert!(snapshot.dirty);
    assert_eq!(std::fs::read_to_string(&f.path).unwrap(), OTHER);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn adding_local_exclude_reloads_open_ignore_document() {
    let f = Fixture::new().await;
    let path = f.project.root.join(".git/info/exclude");
    let doc = f.project.documents.open(&path).unwrap();
    let ignored = f.project.root.join("generated.txt");
    std::fs::write(&ignored, "generated\n").unwrap();
    vcs::vcs_add_to_ignore(&f.host, "main", vec![ignored], ide_vcs::IgnoreDestination::LocalExclude).await.unwrap();
    let disk = std::fs::read_to_string(&path).unwrap();
    assert!(disk.contains("/generated.txt"));
    assert_eq!(f.project.documents.snapshot(doc.id).unwrap().text, disk);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn commit_hook_reloads_clean_open_documents() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new().await;
    f.saved_edit(&format!("{ORIGINAL}\n"));
    git(&f.project.root, &["add", "-u"]);
    let hook = f.project.root.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nprintf 'SELECT hook;' > node_modules/query.sql\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    vcs::vcs_commit(
        &f.host,
        "main",
        None,
        "commit with hook".into(),
        ide_vcs::CommitOptions { run_hooks: true, ..Default::default() },
    )
    .await
    .unwrap();
    f.assert_clean("SELECT hook;");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worktree_checkout_hook_reloads_clean_open_documents() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new().await;
    let hook = f.project.root.join(".git/hooks/post-checkout");
    std::fs::write(&hook, "#!/bin/sh\nprintf 'SELECT hook;' > ../project/node_modules/query.sql\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let linked = f.project.root.parent().unwrap().join("linked");
    vcs::vcs_add_worktree(&f.host, "main", None, linked, "other".into(), None).await.unwrap();
    f.assert_clean("SELECT hook;");
}
