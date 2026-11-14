//! Shelves retain their repository even when the project root is above or below it.
use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops::vcs};
use std::{path::Path, process::Command, sync::Arc, time::Duration};

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

async fn check_shelves(layout: &str) {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let project_root = base.join("project");
    let roots = match layout {
        "same" => vec![project_root.clone()],
        "below" => vec![base.clone()],
        "two" => vec![project_root.join("项目A"), project_root.join("repoB")],
        _ => vec![project_root.join("项目A")],
    };
    std::fs::create_dir_all(project_root.join("dirB")).unwrap();
    for (i, root) in roots.iter().enumerate() {
        std::fs::create_dir_all(root.join("src")).unwrap();
        git(root, &["init", "-b", "main"]);
        git(root, &["config", "user.name", "Test"]);
        git(root, &["config", "user.email", "test@example.com"]);
        std::fs::write(root.join("src/same.txt"), format!("base {i}\n")).unwrap();
        git(root, &["add", "src"]);
        git(root, &["commit", "-m", "initial"]);
        std::fs::write(root.join("src/same.txt"), format!("shelved {i}\n")).unwrap();
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
    host.trust.decide(&project_root, true, false).unwrap();
    let project = host.open_project("main", &project_root).unwrap();
    for _ in 0..500 {
        if project.repos().all().len() == roots.len() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(project.repos().all().len(), roots.len());
    let primary = project.repos().primary().unwrap().root().to_path_buf();
    if roots.len() == 2 {
        assert!(
            vcs::vcs_shelve(&host, "main", "mixed".into(), roots.iter().map(|r| r.join("src/same.txt")).collect())
                .await
                .is_err()
        );
        assert!(vcs::vcs_shelves(&host, "main").unwrap().is_empty());
    }
    for (i, root) in roots.iter().enumerate() {
        let entry = vcs::vcs_shelve(&host, "main", "work".into(), vec![root.join("src/same.txt")]).await.unwrap();
        assert_eq!(entry.repo.as_deref(), Some(root.as_path()));
        assert_eq!(std::fs::read_to_string(root.join("src/same.txt")).unwrap(), format!("base {i}\n"));
        let listed = vcs::vcs_shelves(&host, "main").unwrap();
        assert_eq!(listed.iter().find(|s| s.id == entry.id).unwrap().repo, entry.repo);
        let diffs = vcs::vcs_shelf_diff(&host, "main", entry.id.clone()).await.unwrap();
        assert_eq!(diffs[0].before.as_deref(), Some(format!("base {i}\n").as_str()));
        assert_eq!(diffs[0].after.as_deref(), Some(format!("shelved {i}\n").as_str()));
        vcs::vcs_shelf_rename(&host, "main", entry.id.clone(), "renamed".into()).unwrap();
        let patch = vcs::vcs_shelf_patch(&host, "main", entry.id.clone(), None).unwrap();
        vcs::vcs_shelf_import(&host, "main", Some(root.clone()), "imported".into(), patch).await.unwrap();
        let imported = vcs::vcs_shelves(&host, "main").unwrap().into_iter().find(|s| s.name == "imported").unwrap();
        assert_eq!(imported.repo, entry.repo);
        vcs::vcs_shelf_delete(&host, "main", imported.id, None).unwrap();
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
                vcs::vcs_shelves(&host, "main").unwrap().into_iter().find(|s| s.id == entry.id).unwrap().repo,
                entry.repo
            );
            assert_eq!(
                vcs::vcs_shelf_diff(&host, "main", entry.id).await.unwrap()[0].after.as_deref(),
                Some(format!("shelved {i}\n").as_str())
            );
        }
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
