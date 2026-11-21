use ide_core::{NullSink, RequestId};
use ide_host::{
    Host, HostConfig,
    ops::{Channel, fs::fs_synchronize_directories},
};
use ide_vfs::{DirectorySyncAction as Action, DirectorySyncOperation, DirectorySyncProgress};
use parking_lot::Mutex;
use std::{fs, path::Path, sync::Arc};

fn put(root: &Path, path: &str, content: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn op(path: &str, action: Action, overwrite: bool) -> DirectorySyncOperation {
    DirectorySyncOperation { path: path.into(), action, overwrite }
}

fn host(base: &Path) -> Host {
    Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_every_operation_reports_failures_and_stops_when_cancelled() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("project");
    let (left, right) = (root.join("left"), root.join("right"));
    put(&left, "only-left/deep/nested/a.txt", "nested");
    put(&left, "changed.txt", "left");
    put(&right, "changed.txt", "right");
    put(&left, "kept.txt", "left");
    put(&right, "kept.txt", "right");
    put(&right, "shared/new.txt", "right");
    fs::create_dir_all(left.join("shared")).unwrap();
    let host = host(&base);
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();

    let progress = Arc::new(Mutex::new(Vec::<DirectorySyncProgress>::new()));
    let seen = progress.clone();
    let channel = Channel::new(move |p| seen.lock().push(p));
    let failures = fs_synchronize_directories(
        &host,
        "main",
        left.clone(),
        right.clone(),
        vec![
            op("only-left", Action::CopyToRight, false),
            // Not confirmed: the destination exists, so this one fails and the rest still run.
            op("kept.txt", Action::CopyToRight, false),
            op("changed.txt", Action::CopyToLeft, true),
            op("shared", Action::CopyToLeft, false),
            // A real delete would go to this machine's Trash; a missing entry still fails the same way.
            op("missing.txt", Action::DeleteLeft, false),
        ],
        RequestId::next(),
        channel.clone(),
    )
    .await
    .unwrap();
    assert_eq!(fs::read_to_string(right.join("only-left/deep/nested/a.txt")).unwrap(), "nested");
    assert_eq!(fs::read_to_string(right.join("kept.txt")).unwrap(), "right");
    assert_eq!(fs::read_to_string(left.join("changed.txt")).unwrap(), "right");
    assert_eq!(fs::read_to_string(left.join("shared/new.txt")).unwrap(), "right");
    let failed: Vec<_> = failures.iter().map(|f| (f.path.as_str(), f.action)).collect();
    assert_eq!(failed, [("kept.txt", Action::CopyToRight), ("missing.txt", Action::DeleteLeft)]);
    let done: Vec<_> = progress.lock().iter().map(|p| (p.done, p.total)).collect();
    assert_eq!(done, (0..=5).map(|d| (d, 5)).collect::<Vec<_>>());

    // A path outside the roots rejects the whole batch before anything runs.
    let error = fs_synchronize_directories(
        &host,
        "main",
        left.clone(),
        right.clone(),
        vec![op("kept.txt", Action::CopyToRight, true), op("../escape", Action::DeleteLeft, false)],
        RequestId::next(),
        channel.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind, ide_core::error::ErrorKind::InvalidInput);
    assert_eq!(fs::read_to_string(right.join("kept.txt")).unwrap(), "right");

    let request = RequestId::next();
    host.cancel_request(request);
    let error = fs_synchronize_directories(
        &host,
        "main",
        left.clone(),
        right.clone(),
        vec![op("kept.txt", Action::CopyToRight, true)],
        request,
        channel,
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind, ide_core::error::ErrorKind::Cancelled);
    assert_eq!(fs::read_to_string(right.join("kept.txt")).unwrap(), "right");
}
