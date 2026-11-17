//! An image path may come from Markdown someone else wrote, and on Windows opening a network
//! share signs in to its server with the user's credentials: the host reads an image from a
//! share only when a project is open on it. The share here is this machine's own `C$` over
//! loopback.
#![cfg(windows)]

use ide_core::NullSink;
use ide_host::ops::bytes::fs_read_image;
use ide_host::{Host, HostConfig};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// `path` as seen through the admin share of `server`, a name of this machine.
fn over_smb(server: &str, path: &Path) -> PathBuf {
    let s = path.to_str().unwrap();
    PathBuf::from(format!(r"\\{server}\{}${}", &s[..1], &s[2..]))
}

#[test]
fn images_on_a_share_are_read_only_where_a_project_is_open() {
    let tmp = tempfile::tempdir().unwrap();
    let local = dunce::canonicalize(tmp.path()).unwrap();
    let root = local.join("project");
    std::fs::create_dir_all(root.join("docs")).unwrap();
    for image in [root.join("docs/a.png"), local.join("outside.png")] {
        std::fs::write(image, b"\x89PNG dummy").unwrap();
    }
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let _guard = runtime.enter();
    let host = Host::new(HostConfig {
        config_dir: tmp.path().join("config"),
        data_dir: tmp.path().join("data"),
        local_data_dir: tmp.path().join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: runtime.handle().clone(),
        project_environment: false,
    });
    let read = |path: PathBuf| runtime.block_on(fs_read_image(&host, "main", path));

    let in_project = over_smb("127.0.0.1", &root.join("docs/a.png"));
    let beside_project = over_smb("127.0.0.1", &local.join("outside.png"));
    let other_server = over_smb("localhost", &root.join("docs/a.png"));
    for path in [&in_project, &beside_project, &other_server] {
        assert!(std::fs::read(path).is_ok(), "control: {} is not reachable over SMB", path.display());
    }
    let wanted = read(root.join("docs/a.png")).unwrap();

    // No project is open on any share.
    for path in [&in_project, &beside_project, &other_server] {
        assert!(read(path.clone()).is_err(), "read {} with no project on its share", path.display());
    }

    let project_root = over_smb("127.0.0.1", &root);
    host.trust.decide(&project_root, true, false).unwrap();
    host.open_project("main", &project_root).unwrap();
    assert_eq!(read(in_project.clone()).unwrap(), wanted);
    // The whole share is one sign-in: a file outside the project folder is on it too.
    assert_eq!(read(beside_project.clone()).unwrap(), wanted);
    assert_eq!(read(PathBuf::from(in_project.to_str().unwrap().replace('\\', "/"))).unwrap(), wanted);
    // The path as the webview holds it: the project root it was given, joined with `/`.
    let root_in_webview = ide_core::ipc_path::to_ipc(&host.project("main").unwrap().root);
    assert_eq!(read(PathBuf::from(format!("{root_in_webview}/docs/a.png"))).unwrap(), wanted);
    assert!(read(other_server.clone()).is_err(), "read {} from a server no project is on", other_server.display());

    host.close_project("main");
    assert!(read(in_project.clone()).is_err(), "read {} after its project closed", in_project.display());
}
