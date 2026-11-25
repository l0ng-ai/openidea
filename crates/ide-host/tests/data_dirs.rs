mod common;

use ide_host::{Host, HostConfig, ops};

#[tokio::test]
async fn startup_moves_legacy_ssh_credentials_without_opening_a_project_or_connection() {
    use ide_ssh::secrets::testing::{files_containing, use_memory_store};

    use_memory_store();
    let tmp = tempfile::tempdir().unwrap();
    let config = common::host_config(tmp.path());
    std::fs::create_dir_all(&config.data_dir).unwrap();
    std::fs::write(config.data_dir.join("ssh-passwords.json"), r#"{"box":"legacy-fixture"}"#).unwrap();
    let host = Host::new(config);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !files_containing(tmp.path(), "legacy-fixture").is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("startup migration");
    assert_eq!(host.ssh.password("box").as_deref(), Some("legacy-fixture"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn split_storage_keeps_user_history_and_uses_local_tools_and_caches() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let data = base.join("roaming");
    let local = base.join("local");
    let root = base.join("project");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("notes.txt"), "hello\n").unwrap();
    let host =
        Host::new(HostConfig { data_dir: data.clone(), local_data_dir: local.clone(), ..common::host_config(&base) });
    assert_eq!(std::path::PathBuf::from(ops::tools::jdk_download_location(&host).unwrap()), local.join("tools/jdks"));
    let light = host.open_light("main", &root.join("notes.txt")).unwrap();
    assert!(light.cache_dir.starts_with(&local));
    assert!(data.join("history").exists());
    assert!(!local.join("history").exists());
    let project = host.open_project("main", &root).unwrap();
    assert!(project.cache_dir.starts_with(&local));
    assert!(local.join("index").exists());
    assert!(!data.join("index").exists());
    assert!(!data.join("tools").exists());
    host.shutdown().await;
}
