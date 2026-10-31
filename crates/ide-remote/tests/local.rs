//! Local deployment uses the service entry points used by SFTP and save hooks.
use ide_core::CancellationToken;
use ide_core::remote_settings::{AutoUpload, DeploymentMapping, DeploymentServer, DeploymentType};
use ide_core::settings::Settings;
use ide_remote::{RemoteService, SyncAction, SyncStatus, SyncStep};
use ide_ssh::{FsConnection, SshFiles, SshManager};
use std::path::Path;
use std::sync::Arc;

fn service(root: &Path) -> RemoteService {
    RemoteService::new(
        Arc::new(SshManager::with_files(
            root.join("secrets"),
            SshFiles { known_hosts: root.join("known_hosts"), config: None },
        )),
        root.join("cache"),
    )
}

fn settings(target: &Path) -> Settings {
    let mut s = Settings::default();
    s.deployment.servers.push(DeploymentServer {
        id: "local".into(),
        kind: DeploymentType::Local,
        root_path: target.to_string_lossy().into_owned(),
        mappings: vec![DeploymentMapping { deployment: "app".into(), ..Default::default() }],
        excluded_paths: vec!["app/private".into()],
        ..Default::default()
    });
    s.deployment.default_server = "local".into();
    s.deployment.auto_upload = AutoUpload::Always;
    s.deployment.delete_remote = true;
    s
}

#[tokio::test]
async fn local_deployment_and_browser_share_all_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("project");
    let target = tmp.path().join("mounted");
    std::fs::create_dir_all(root.join("src/nested")).unwrap();
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::create_dir_all(root.join("private")).unwrap();
    std::fs::create_dir(&target).unwrap();
    std::fs::write(root.join("src/nested/a.txt"), "initial").unwrap();
    std::fs::write(root.join(".git/config"), "excluded").unwrap();
    std::fs::write(root.join("private/key"), "excluded remote path").unwrap();
    let service = service(tmp.path());
    let settings = settings(&target);
    let cancel = CancellationToken::new();
    service.test_connection(&FsConnection::Local, target.to_str().unwrap()).await.unwrap();
    let report = service
        .upload(&settings, &root, None, std::slice::from_ref(&root), cancel.clone(), &mut |_, _, _| {})
        .await
        .unwrap();
    assert_eq!(report.files, 1, "{report:?}");
    assert!(report.errors.is_empty(), "{report:?}");
    assert!(!target.join("app/.git").exists());
    assert!(!target.join("app/private").exists());
    assert_eq!(
        ide_ssh::sftp::mtime_of(&root.join("src/nested/a.txt")),
        ide_ssh::sftp::mtime_of(&target.join("app/src/nested/a.txt"))
    );
    let compared = service.compare(&settings, &root, None, &root, cancel.clone()).await.unwrap();
    assert_eq!(compared.iter().find(|e| e.path == "src/nested/a.txt").unwrap().status, SyncStatus::Same);
    std::fs::write(root.join("src/nested/a.txt"), "saved").unwrap();
    let saved = service.on_saved(&settings, &root, &root.join("src/nested/a.txt")).await.unwrap().unwrap();
    assert!(saved.errors.is_empty());
    let remote_file = target.join("app/src/nested/a.txt");
    assert_eq!(std::fs::read_to_string(&remote_file).unwrap(), "saved");
    std::fs::write(&remote_file, "downloaded").unwrap();
    let report =
        service.download(&settings, &root, None, &[root.join("src")], cancel.clone(), &mut |_, _, _| {}).await.unwrap();
    assert!(report.errors.is_empty());
    assert_eq!(std::fs::read_to_string(root.join("src/nested/a.txt")).unwrap(), "downloaded");
    let connection = FsConnection::Local;
    let entries = service.list(&connection, target.join("app/src/nested").to_str().unwrap()).await.unwrap();
    assert_eq!(entries[0].name, "a.txt");
    let cached = service.open_remote(&connection, remote_file.to_str().unwrap()).await.unwrap();
    std::fs::write(&cached, "remote edit").unwrap();
    assert!(service.on_saved(&settings, &root, &cached).await.unwrap().unwrap().errors.is_empty());
    assert_eq!(std::fs::read_to_string(&remote_file).unwrap(), "remote edit");
    service.remote_mkdir(&connection, target.join("browser/new/nested").to_str().unwrap()).await.unwrap();
    service
        .remote_rename(&connection, target.join("browser").to_str().unwrap(), target.join("renamed").to_str().unwrap())
        .await
        .unwrap();
    service.remote_delete(&connection, target.join("renamed").to_str().unwrap()).await.unwrap();
    assert!(!target.join("renamed").exists());
    let report = service
        .sync(
            &settings,
            &root,
            None,
            &[SyncStep { path: "src/nested/a.txt".into(), action: SyncAction::Download }],
            cancel,
            &mut |_, _, _| {},
        )
        .await
        .unwrap();
    assert_eq!(report.files, 1);
    std::fs::remove_file(root.join("src/nested/a.txt")).unwrap();
    assert!(
        service
            .on_deleted(&settings, &root, &[root.join("src/nested/a.txt")])
            .await
            .unwrap()
            .unwrap()
            .errors
            .is_empty()
    );
    assert!(!remote_file.exists());
}

#[tokio::test]
async fn self_upload_download_and_aliases_never_destroy_content() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let service = service(root);
    let mut settings = settings(root);
    settings.deployment.servers[0].mappings[0].deployment.clear();
    let file = root.join("file");
    std::fs::write(&file, "keep me").unwrap();
    for download in [false, true] {
        let report = if download {
            service
                .download(
                    &settings,
                    root,
                    None,
                    std::slice::from_ref(&file),
                    CancellationToken::new(),
                    &mut |_, _, _| {},
                )
                .await
        } else {
            service
                .upload(&settings, root, None, std::slice::from_ref(&file), CancellationToken::new(), &mut |_, _, _| {})
                .await
        }
        .unwrap();
        assert!(report.errors[0].message.contains("same file"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "keep me");
    }
    #[cfg(unix)]
    {
        let alias = root.join("alias");
        std::fs::hard_link(&file, &alias).unwrap();
        assert!(
            ide_ssh::RemoteFs::Local
                .upload(&file, alias.to_str().unwrap(), true)
                .await
                .unwrap_err()
                .message
                .contains("same file")
        );
        std::fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(&file, &alias).unwrap();
        assert!(
            ide_ssh::RemoteFs::Local
                .upload(&file, alias.to_str().unwrap(), true)
                .await
                .unwrap_err()
                .message
                .contains("same file")
        );
        ide_ssh::RemoteFs::Local.remove(alias.to_str().unwrap()).await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "keep me");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn missing_non_directory_and_unwritable_targets_are_clear() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let service = service(tmp.path());
    let target = tmp.path().join("target");
    assert!(
        service
            .test_connection(&FsConnection::Local, target.to_str().unwrap())
            .await
            .unwrap_err()
            .message
            .contains("does not exist")
    );
    std::fs::write(&target, "file").unwrap();
    assert!(
        service
            .test_connection(&FsConnection::Local, target.to_str().unwrap())
            .await
            .unwrap_err()
            .message
            .contains("Not a folder")
    );
    std::fs::remove_file(&target).unwrap();
    std::fs::create_dir(&target).unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o555)).unwrap();
    let result = service.test_connection(&FsConnection::Local, target.to_str().unwrap()).await;
    let file = tmp.path().join("source");
    std::fs::write(&file, "data").unwrap();
    let mut settings = settings(&target);
    settings.deployment.servers[0].mappings[0].deployment.clear();
    let report = service
        .upload(&settings, tmp.path(), None, &[file], CancellationToken::new(), &mut |_, _, _| {})
        .await
        .unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(result.unwrap_err().message.contains("not writable"));
    assert_eq!(report.errors.len(), 1, "{report:?}");
}
