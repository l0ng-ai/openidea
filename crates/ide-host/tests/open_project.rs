//! Opening the project a window is already opening reuses it: racing opens (a double
//! click, a launch path and a restore) must not start a second index and language servers.

use ide_core::NullSink;
use ide_host::{Host, HostConfig};
use std::sync::{Arc, Barrier};

#[test]
fn racing_opens_of_one_window_share_one_project() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/Main.java"), "class Main {}\n").unwrap();
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let _guard = runtime.enter();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: tmp.path().join("config"),
        data_dir: tmp.path().join("data"),
        local_data_dir: tmp.path().join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: runtime.handle().clone(),
        project_environment: false,
    }));
    host.trust.decide(&root, true, false).unwrap();

    let start = Arc::new(Barrier::new(4));
    let opens: Vec<_> = (0..4)
        .map(|_| {
            let (host, root, start) = (host.clone(), root.clone(), start.clone());
            std::thread::spawn(move || {
                start.wait();
                host.open_project("main", &root).unwrap()
            })
        })
        .collect();
    let projects: Vec<_> = opens.into_iter().map(|t| t.join().unwrap()).collect();

    let current = host.project("main").unwrap();
    for project in &projects {
        assert!(Arc::ptr_eq(project, &current), "every open returns the window's one project");
    }
    host.close_project("main");
}
