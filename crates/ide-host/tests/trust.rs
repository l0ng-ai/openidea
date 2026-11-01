use ide_core::NullSink;
#[cfg(unix)]
use ide_host::ops;
use ide_host::{Host, HostConfig, trust::TrustStore};
use std::path::Path;
use std::sync::Arc;
#[cfg(unix)]
use std::time::{Duration, Instant};

fn host(base: &Path, environment: bool) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: environment,
    }))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn application_commands_work_in_restricted_projects_and_without_a_project() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let host = host(&tmp.path().join("app"), false);
    assert!(host.project("welcome").is_err());
    assert!(ide_host::ops::project::roots(&host, "welcome").is_err());
    assert!(!host.open_project("main", &root).unwrap().is_trusted());
    for command in [
        "app_info",
        "app_build_info",
        "app_log_location",
        "app_check_update",
        "app_startup_update_check",
        "app_install_update",
        "caches_schedule_invalidation",
        "clear_caches",
        "clipboard_file_list",
        "clipboard_has_files",
        "clipboard_set_file_list",
        "jdk_download_vendors",
        "jdk_download_releases",
        "jdk_download_location",
        "jdk_download",
        "run_system_env",
        "run_gradle_jvm_args_script",
        "proxy_check_connection",
        "docker_settings",
        "docker_save_settings",
        "docker_set_registry_password",
        "docker_run_env",
        "db_console_path",
        "db_export_file",
        "vcs_write_patch",
    ] {
        assert!(ide_host::trust::restricted_command_allowed(command), "{command}");
        for window in ["main", "welcome"] {
            assert!(host.authorize_command(window, command).is_ok(), "{window}: {command}");
        }
    }
    for command in [
        "run_start",
        "build_sync",
        "debug_start",
        "sdk_detect",
        "tools_list",
        "tools_install",
        "tools_uninstall",
        "plugin_install_dir",
        "plugin_reload",
        "vcs_git_version",
        "docker_compose_op",
        "db_execute",
        "unknown_command",
    ] {
        assert!(!ide_host::trust::restricted_command_allowed(command), "{command}");
        for window in ["main", "welcome"] {
            assert!(host.authorize_command(window, command).is_err(), "{window}: {command}");
        }
    }
    // These requests validate the vendor before any network access, independently of project trust.
    for window in ["main", "welcome"] {
        let error = ide_host::ops::tools::jdk_download_releases(
            &host,
            window,
            "unknown-vendor".into(),
            ide_core::RequestId(901),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, ide_core::error::ErrorKind::InvalidInput);
        let error = ide_host::ops::tools::jdk_download(
            &host,
            window,
            "unknown-vendor".into(),
            25,
            None,
            ide_core::RequestId(902),
            ide_host::ops::Channel::new(|_| {}),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, ide_core::error::ErrorKind::InvalidInput);
    }
    host.shutdown().await;
}

#[test]
fn persists_user_decisions_locations_revocation_and_one_time_migration() {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config");
    let data = tmp.path().join("data");
    let a = tmp.path().join("projects/a");
    let b = tmp.path().join("projects/b");
    std::fs::create_dir_all(a.join(".openidea")).unwrap();
    std::fs::create_dir_all(b.join(".openidea")).unwrap();
    std::fs::write(a.join(".openidea/project-trust.json"), r#"{"trusted":true}"#).unwrap();
    std::fs::write(b.join(".openidea/project-trust.json"), r#"{"trusted":true}"#).unwrap();
    let recent = ide_workspace::RecentProjects::load(&config);
    recent.touch(&a, None).unwrap();
    let trust = TrustStore::load(&config, &data);
    assert!(trust.trusted(&a).unwrap());
    assert!(!trust.status(&b).unwrap().decided);
    recent.touch(&b, None).unwrap();
    let trust = TrustStore::load(&config, &data);
    assert!(!trust.trusted(&b).unwrap(), "migration is not repeated");
    trust.decide(&a, true, true).unwrap();
    assert!(trust.trusted(&b).unwrap());
    trust.decide(&b, false, false).unwrap();
    assert!(!trust.trusted(&b).unwrap(), "revocation overrides a trusted location");
    let trust = TrustStore::load(&config, &data);
    assert!(!trust.trusted(&b).unwrap());
    trust.remove_location(&dunce::canonicalize(a.parent().unwrap()).unwrap()).unwrap();
    assert!(trust.trusted(&a).unwrap());
    trust.decide(&a, false, false).unwrap();
    assert!(!TrustStore::load(&config, &data).trusted(&a).unwrap());
    std::fs::write(data.join("project-trust.json"), "broken").unwrap();
    assert!(TrustStore::load(&config, &data).trusted(&a).is_err(), "corruption fails closed");
}

#[cfg(unix)]
fn script(root: &Path, name: &str, marker: &str) {
    use std::os::unix::fs::PermissionsExt;
    let path = root.join(name);
    std::fs::write(&path, format!("#!/bin/sh\nprintf executed > '{marker}'\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn malicious_project_stays_editable_then_starts_in_place_after_trust() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("malicious");
    std::fs::create_dir_all(root.join(".openidea")).unwrap();
    script(&root, "hook", "hook.marker");
    script(&root, "server", "lsp.marker");
    script(&root, "gradlew", "build.marker");
    std::fs::write(root.join("build.gradle"), "plugins { id 'java' }").unwrap();
    std::fs::write(root.join("main.py"), "print('safe')\n").unwrap();
    std::fs::write(root.join(".devcontainer.json"), r#"{"postStartCommand":["./hook"]}"#).unwrap();
    std::fs::write(root.join(".openidea/settings.toml"), format!(
        "[languageServers.trust-witness]\nlanguages = ['python']\ncommand = {:?}\n[languageServers.pyright]\nenabled = false\n", root.join("server").to_str().unwrap()
    )).unwrap();
    let host = host(&tmp.path().join("app"), true);
    let project = host.open_project("main", &root).unwrap();
    assert!(!project.is_trusted());
    let doc = ops::doc::open(&host, "main", root.join("main.py")).await.unwrap();
    ops::doc::save(&host, "main", doc.id).await.unwrap();
    assert!(project.index.wait_idle(Duration::from_secs(10)));
    assert!(project.index.status().files > 0);
    let sync = || {
        ops::build::build_sync(
            &host,
            "main",
            ide_build::BuildTool::Gradle,
            ide_core::RequestId(472),
            false,
            vec![],
            ops::Channel::new(|_| {}),
        )
    };
    assert!(sync().await.is_err(), "restricted build marker: {}", root.join("build.marker").exists());
    assert!(
        ops::sdk::sdk_locate_tools(&host, "missing-window", vec!["server".into()], Some(root.clone())).await.is_err()
    );
    for command in [
        "run_start",
        "debug_start",
        "notebook_execute",
        "coverage_collect",
        "profiler_collect",
        "docker_compose_op",
        "agent_prompt",
        "sdk_detect",
        "build_sync",
    ] {
        assert!(host.authorize_command("main", command).is_err(), "{command}");
        assert!(host.authorize_command("missing-window", command).is_err(), "{command}");
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    for marker in ["hook.marker", "lsp.marker", "build.marker"] {
        assert!(!root.join(marker).exists(), "{marker}");
    }
    host.set_project_trust(&root, true, false).await.unwrap();
    assert!(Arc::ptr_eq(&project, &host.project("main").unwrap()));
    assert_eq!(project.documents.snapshot(doc.id).unwrap().text, doc.text);
    sync().await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !root.join("hook.marker").exists() || !root.join("lsp.marker").exists() {
        assert!(Instant::now() < deadline, "trusted services must start");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(root.join("build.marker").exists());
    host.set_project_trust(&root, false, false).await.unwrap();
    assert!(!project.is_trusted());
    assert!(sync().await.is_err());
    ops::doc::save(&host, "main", doc.id).await.unwrap();
    host.shutdown().await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restricted_terminal_keeps_user_input_but_ignores_project_startup_commands() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
    std::fs::create_dir_all(&root).unwrap();
    let host = host(&tmp.path().join("app"), false);
    host.global_settings
        .set(
            ide_workspace::SettingsScope::Global,
            "terminal.env",
            serde_json::json!({"ZDOTDIR": root, "ENV": "/dev/null", "BASH_ENV": "/dev/null"}),
        )
        .unwrap();
    host.open_project("main", &root).unwrap();
    let terminal = ops::term::spawn(
        &host,
        "main",
        ide_terminal::TerminalOptions {
            cwd: root.clone().into(),
            shell: Some("/bin/sh".into()),
            args: vec!["-c".into(), "touch automatic.marker".into()],
            env: Default::default(),
            cols: 80,
            rows: 24,
            shell_integration: false,
        },
        Arc::new(|_| {}),
    )
    .unwrap();
    host.terminals.write(terminal.id, "printf user > terminal.marker; exit\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !root.join("terminal.marker").exists() {
        assert!(Instant::now() < deadline, "user terminal input must run");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!root.join("automatic.marker").exists());
    host.shutdown().await;
}

#[cfg(unix)]
#[test]
fn trusted_locations_use_canonical_directory_boundaries() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("trusted/project");
    let other = tmp.path().join("trusted-other/project");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    std::os::unix::fs::symlink(other.parent().unwrap(), root.parent().unwrap().join("escape")).unwrap();
    let trust = TrustStore::load(&tmp.path().join("config"), &tmp.path().join("data"));
    trust.decide(&root, true, true).unwrap();
    assert!(!trust.trusted(&other).unwrap());
    let alias = root.parent().unwrap().join("escape/project");
    assert!(!trust.trusted(&alias).unwrap());
    assert_eq!(trust.status(&alias).unwrap().root.as_ref(), dunce::canonicalize(&other).unwrap());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restricted_git_views_ignore_project_executables_and_mutations_cannot_run_hooks() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
    std::fs::create_dir_all(root.join(".openidea")).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git").current_dir(&root).args(args).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    };
    git(&["init", "-q"]);
    git(&["config", "user.name", "Test"]);
    git(&["config", "user.email", "test@example.com"]);
    git(&["config", "commit.gpgsign", "false"]);
    git(&["config", "core.hooksPath", ".git/hooks"]);
    let file = root.join("safe.txt");
    std::fs::write(&file, "safe\n").unwrap();
    script(&root, ".git/hooks/pre-commit", "git-hook.marker");
    let executable = root.join(".openidea/git-witness");
    std::fs::write(&executable, "#!/bin/sh\nprintf executed > git-executable.marker\nexec git \"$@\"\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(
        root.join(".openidea/settings.toml"),
        format!("[vcs.git]\nexecutable = {:?}\n", executable.to_str().unwrap()),
    )
    .unwrap();
    let host = host(&tmp.path().join("app"), false);
    let project = host.open_project("main", &root).unwrap();
    assert!(!project.with_repo(|repo| repo.status()).unwrap().is_empty());
    assert!(ops::vcs::vcs_stage(&host, "main", vec![file.clone()]).await.is_err());
    assert!(!root.join("git-hook.marker").exists());
    assert!(!root.join("git-executable.marker").exists());
    host.set_project_trust(&root, true, false).await.unwrap();
    ops::vcs::vcs_stage(&host, "main", vec![file]).await.unwrap();
    project.with_repo(|repo| repo.commit("trusted", false, false)).unwrap();
    assert!(root.join("git-executable.marker").exists());
    assert!(root.join("git-hook.marker").exists());
    ide_vcs::set_git_executable(None);
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revocation_still_applies_when_a_project_folder_was_removed() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let host = host(&tmp.path().join("app"), false);
    host.trust.decide(&root, true, true).unwrap();
    let project = host.open_project("main", &root).unwrap();
    std::fs::remove_dir_all(&root).unwrap();
    host.set_project_trust(&project.root, false, false).await.unwrap();
    assert!(!project.is_trusted());
    host.shutdown().await;
}
