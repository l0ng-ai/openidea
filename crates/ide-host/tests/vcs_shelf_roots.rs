//! Shelves retain their repository even when the project root is above or below it.
use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops::vcs};
use std::{path::Path, process::Command, sync::Arc, time::Duration};

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

async fn open_project(base: &Path, root: &Path, repo_count: usize) -> Host {
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
    host.trust.decide(root, true, false).unwrap();
    let project = host.open_project("main", root).unwrap();
    for _ in 0..500 {
        if project.repos().all().len() == repo_count {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(project.repos().all().len(), repo_count);
    host
}

async fn check_shelves(layout: &str) {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let project_root = base.join("project");
    let roots = match layout {
        "same" => vec![project_root.clone()],
        "below" => vec![base.clone()],
        "two" => vec![project_root.join("项目A"), project_root.join("repo B")],
        _ => vec![project_root.join("项目A")],
    };
    std::fs::create_dir_all(project_root.join("dirB")).unwrap();
    for (i, root) in roots.iter().enumerate() {
        std::fs::create_dir_all(root.join("src")).unwrap();
        git(root, &["init", "-b", "main"]);
        git(root, &["config", "user.name", "Test"]);
        git(root, &["config", "user.email", "test@example.com"]);
        git(root, &["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("src/same.txt"), format!("base {i}\n")).unwrap();
        git(root, &["add", "src"]);
        git(root, &["commit", "-m", "initial"]);
        std::fs::write(root.join("src/same.txt"), format!("shelved {i}\n")).unwrap();
    }
    let host = open_project(&base, &project_root, roots.len()).await;
    let project = host.project("main").unwrap();
    let primary = project.repos().primary().unwrap().root().to_path_buf();
    if roots.len() == 2 {
        assert!(
            vcs::vcs_shelve(
                &host,
                "main",
                "outside".into(),
                vec![roots[0].join("src/same.txt"), project_root.join("dirB/unmapped.txt")],
            )
            .await
            .is_err()
        );
        let entry =
            vcs::vcs_shelve(&host, "main", "mixed".into(), roots.iter().map(|r| r.join("src/same.txt")).collect())
                .await
                .unwrap();
        let key = |root: &Path| format!("{}/src/same.txt", root.file_name().unwrap().to_str().unwrap());
        assert_eq!(entry.repo.as_deref(), Some(project_root.as_path()));
        assert_eq!(entry.files.len(), 2);
        let listed = vcs::vcs_shelves(&host, "main").await.unwrap();
        assert_eq!(listed.len(), 1);
        let diffs = vcs::vcs_shelf_diff(&host, "main", entry.id.clone()).await.unwrap();
        for (i, root) in roots.iter().enumerate() {
            let diff = diffs.iter().find(|diff| diff.path == key(root)).unwrap();
            assert_eq!(diff.before.as_deref(), Some(format!("base {i}\n").as_str()));
            assert_eq!(diff.after.as_deref(), Some(format!("shelved {i}\n").as_str()));
            assert_eq!(std::fs::read_to_string(root.join("src/same.txt")).unwrap(), format!("base {i}\n"));
        }
        let saved = ide_core::project_dir::path(&project_root, "shelf").join(&entry.id).join("shelf.json");
        let original = std::fs::read(&saved).unwrap();
        std::fs::remove_file(&saved).unwrap();
        assert!(vcs::vcs_unshelve(&host, "main", entry.id.clone(), true, None).await.is_err());
        let mut metadata: serde_json::Value = serde_json::from_slice(&original).unwrap();
        metadata["repositories"][1]["root"] = serde_json::json!(base.join("missing-repository"));
        std::fs::write(&saved, serde_json::to_vec(&metadata).unwrap()).unwrap();
        assert!(vcs::vcs_unshelve(&host, "main", entry.id.clone(), true, None).await.is_err());
        assert_eq!(std::fs::read_to_string(roots[0].join("src/same.txt")).unwrap(), "base 0\n");
        std::fs::write(saved, original).unwrap();
        let chosen = key(&roots[1]);
        let patch = vcs::vcs_shelf_patch(&host, "main", entry.id.clone(), Some(chosen.clone()), None).await.unwrap();
        assert!(patch.contains(&format!("a/{chosen}")));
        assert!(!patch.contains("+shelved 0"));
        let relocated =
            vcs::vcs_shelf_patch(&host, "main", entry.id.clone(), Some(chosen.clone()), Some(roots[1].join("src")))
                .await
                .unwrap();
        assert!(relocated.contains("diff --git a/same.txt b/same.txt"));
        assert!(relocated.contains("+shelved 1"));
        assert!(!relocated.contains("+shelved 0"));
        let outcome = vcs::vcs_unshelve(&host, "main", entry.id.clone(), true, Some(chosen.clone())).await.unwrap();
        assert_eq!(outcome.applied, [chosen]);
        assert_eq!(std::fs::read_to_string(roots[0].join("src/same.txt")).unwrap(), "base 0\n");
        assert_eq!(std::fs::read_to_string(roots[1].join("src/same.txt")).unwrap(), "shelved 1\n");
        let remainder = vcs::vcs_shelves(&host, "main").await.unwrap();
        assert_eq!(remainder[0].files.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(), [key(&roots[0])]);
        let outcome = vcs::vcs_unshelve(&host, "main", entry.id.clone(), true, None).await.unwrap();
        assert_eq!(outcome.applied, [key(&roots[0])]);
        assert!(vcs::vcs_shelves(&host, "main").await.unwrap().is_empty());
    }
    for (i, root) in roots.iter().enumerate() {
        let entry = vcs::vcs_shelve(&host, "main", "work".into(), vec![root.join("src/same.txt")]).await.unwrap();
        assert_eq!(entry.repo.as_deref(), Some(root.as_path()));
        assert_eq!(std::fs::read_to_string(root.join("src/same.txt")).unwrap(), format!("base {i}\n"));
        let listed = vcs::vcs_shelves(&host, "main").await.unwrap();
        assert_eq!(listed.iter().find(|s| s.id == entry.id).unwrap().repo, entry.repo);
        let diffs = vcs::vcs_shelf_diff(&host, "main", entry.id.clone()).await.unwrap();
        assert_eq!(diffs[0].before.as_deref(), Some(format!("base {i}\n").as_str()));
        assert_eq!(diffs[0].after.as_deref(), Some(format!("shelved {i}\n").as_str()));
        vcs::vcs_shelf_rename(&host, "main", entry.id.clone(), "renamed".into()).await.unwrap();
        let patch = vcs::vcs_shelf_patch(&host, "main", entry.id.clone(), None, None).await.unwrap();
        vcs::vcs_shelf_import(&host, "main", Some(root.clone()), "imported".into(), patch).await.unwrap();
        let imported =
            vcs::vcs_shelves(&host, "main").await.unwrap().into_iter().find(|s| s.name == "imported").unwrap();
        assert_eq!(imported.repo, entry.repo);
        vcs::vcs_shelf_delete(&host, "main", imported.id, None).await.unwrap();
        if root != &primary {
            let info = ide_core::project_dir::path(&project_root, "shelf").join(&entry.id).join("shelf.json");
            let original = std::fs::read(&info).unwrap();
            let mut metadata: serde_json::Value = serde_json::from_slice(&original).unwrap();
            metadata["repo"] = serde_json::json!(base.join("missing-repository"));
            std::fs::write(&info, serde_json::to_vec(&metadata).unwrap()).unwrap();
            assert!(vcs::vcs_shelf_diff(&host, "main", entry.id.clone()).await.is_err());
            assert!(vcs::vcs_unshelve(&host, "main", entry.id.clone(), false, None).await.is_err());
            assert_eq!(std::fs::read_to_string(root.join("src/same.txt")).unwrap(), format!("base {i}\n"));
            std::fs::write(info, original).unwrap();
        }
        vcs::vcs_unshelve(&host, "main", entry.id.clone(), false, Some("src/same.txt".into())).await.unwrap();
        assert_eq!(std::fs::read_to_string(root.join("src/same.txt")).unwrap(), format!("shelved {i}\n"));
        // Old shelves were always made in the primary repository; missing ownership keeps that meaning.
        if root == &primary {
            let info = ide_core::project_dir::path(&project_root, "shelf").join(&entry.id).join("shelf.json");
            let mut metadata: serde_json::Value = serde_json::from_slice(&std::fs::read(&info).unwrap()).unwrap();
            metadata.as_object_mut().unwrap().remove("repo");
            std::fs::write(info, serde_json::to_vec(&metadata).unwrap()).unwrap();
            assert_eq!(
                vcs::vcs_shelves(&host, "main").await.unwrap().into_iter().find(|s| s.id == entry.id).unwrap().repo,
                entry.repo
            );
            assert_eq!(
                vcs::vcs_shelf_diff(&host, "main", entry.id).await.unwrap()[0].after.as_deref(),
                Some(format!("shelved {i}\n").as_str())
            );
        }
    }
    if roots.len() == 2 {
        let entry =
            vcs::vcs_shelve(&host, "main", "conflicts".into(), roots.iter().map(|r| r.join("src/same.txt")).collect())
                .await
                .unwrap();
        std::fs::write(roots[0].join("src/same.txt"), "new HEAD\n").unwrap();
        git(&roots[0], &["commit", "-am", "conflicting change"]);
        let outcome = vcs::vcs_unshelve(&host, "main", entry.id.clone(), true, None).await.unwrap();
        let qualified = |root: &Path| format!("{}/src/same.txt", root.file_name().unwrap().to_str().unwrap());
        assert_eq!(outcome.conflicts, [qualified(&roots[0])]);
        assert_eq!(outcome.applied, [qualified(&roots[1])]);
        assert_eq!(std::fs::read_to_string(roots[1].join("src/same.txt")).unwrap(), "shelved 1\n");
        let listed = vcs::vcs_shelves(&host, "main").await.unwrap();
        let pending = listed.iter().find(|s| s.id == entry.id).unwrap();
        assert_eq!(pending.files.len(), 1);
        assert_eq!(pending.files[0].path, qualified(&roots[0]));
    }
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shelf_at_repo_root() {
    check_shelves("same").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shelf_in_non_git_project() {
    check_shelves("above").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shelves_in_two_repositories() {
    check_shelves("two").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shelf_in_project_below_repository() {
    check_shelves("below").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn automatic_shelf_batch_restores_repositories_independently() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let project_root = base.join("project");
    let clean = project_root.join("repo A");
    let paused = project_root.join("repo B");
    for root in [&clean, &paused] {
        std::fs::create_dir_all(root.join("src")).unwrap();
        git(root, &["init", "-b", "main"]);
        git(root, &["config", "user.name", "Test"]);
        git(root, &["config", "user.email", "test@example.com"]);
        git(root, &["config", "core.autocrlf", "false"]);
        for file in ["src/same.txt", "src/deleted-shelf-file.txt", "merge.txt"] {
            std::fs::write(root.join(file), "base\n").unwrap();
        }
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "base"]);
        git(root, &["switch", "-c", "topic"]);
        std::fs::write(root.join("merge.txt"), "topic\n").unwrap();
        git(root, &["commit", "-am", "topic"]);
        git(root, &["switch", "main"]);
    }
    std::fs::write(paused.join("merge.txt"), "main\n").unwrap();
    git(&paused, &["commit", "-am", "main"]);
    std::fs::write(clean.join("src/same.txt"), "staged in A\n").unwrap();
    git(&clean, &["add", "src/same.txt"]);
    std::fs::write(clean.join("src/deleted-shelf-file.txt"), "remove from shelf\n").unwrap();
    std::fs::write(paused.join("src/same.txt"), "saved in B\n").unwrap();

    let host = open_project(&base, &project_root, 2).await;
    let batch = uuid::Uuid::new_v4().to_string();
    let merge = |repo| vcs::vcs_merge(&host, "main", Some(repo), "topic".into(), Some(batch.clone()), true);
    assert_eq!(merge(clean.clone()).await.unwrap(), ide_vcs::MergeOutcome::Done);
    assert_eq!(merge(paused.clone()).await.unwrap(), ide_vcs::MergeOutcome::Conflicts);
    assert_eq!(std::fs::read_to_string(clean.join("src/same.txt")).unwrap(), "base\n");
    assert_eq!(std::fs::read_to_string(paused.join("src/same.txt")).unwrap(), "base\n");
    let shelves = vcs::vcs_shelves(&host, "main").await.unwrap();
    assert_eq!(shelves.len(), 1);
    let shelf = &shelves[0];
    assert_eq!(shelf.repo.as_deref(), Some(project_root.as_path()));
    assert_eq!(shelf.files.len(), 3);
    let diffs = vcs::vcs_shelf_diff(&host, "main", shelf.id.clone()).await.unwrap();
    for (path, after) in [("repo A/src/same.txt", "staged in A\n"), ("repo B/src/same.txt", "saved in B\n")] {
        let diff = diffs.iter().find(|diff| diff.path == path).unwrap();
        assert_eq!(diff.before.as_deref(), Some("base\n"));
        assert_eq!(diff.after.as_deref(), Some(after));
    }

    let repositories = vec![Some(clean.clone()), Some(paused.clone())];
    vcs::vcs_finish_shelf_batch(&host, "main", uuid::Uuid::new_v4().to_string(), repositories.clone()).await.unwrap();
    assert_eq!(std::fs::read_to_string(clean.join("src/same.txt")).unwrap(), "base\n");
    vcs::vcs_shelf_delete(&host, "main", shelf.id.clone(), Some("repo A/src/deleted-shelf-file.txt".into()))
        .await
        .unwrap();
    vcs::vcs_finish_shelf_batch(&host, "main", batch, repositories).await.unwrap();
    assert_eq!(std::fs::read_to_string(clean.join("src/same.txt")).unwrap(), "staged in A\n");
    assert_eq!(std::fs::read_to_string(clean.join("src/deleted-shelf-file.txt")).unwrap(), "base\n");
    let index = Command::new("git").current_dir(&clean).args(["show", ":src/same.txt"]).output().unwrap();
    assert!(index.status.success());
    assert_eq!(index.stdout, b"staged in A\n");
    assert_eq!(std::fs::read_to_string(paused.join("src/same.txt")).unwrap(), "base\n");
    let pending = vcs::vcs_shelves(&host, "main").await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, shelf.id);
    assert_eq!(pending[0].files.len(), 1);
    assert_eq!(pending[0].files[0].path, "repo B/src/same.txt");
    vcs::vcs_operation(
        &host,
        "main",
        Some(paused.clone()),
        ide_core::RequestId(1),
        vcs::GitOperation::Abort { expected: Some("merge".into()), expected_rebase: None },
        ide_host::ops::Channel::new(|_| {}),
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read_to_string(paused.join("src/same.txt")).unwrap(), "saved in B\n");
    assert!(vcs::vcs_shelves(&host, "main").await.unwrap().is_empty());
    host.close_project("main");
}
