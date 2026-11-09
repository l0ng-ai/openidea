//! Opening each `fixtures/` project the way the app does, through the `ops` its commands call:
//! the source and test roots detected from its build file, the index (files and symbols),
//! Search Everywhere / Go to Class / Go to Symbol answered from it and kept current as files
//! come and go, and the Maven / Gradle model.
//!
//! The `#[ignore]`d tests run Maven, Gradle, python3 and a JDK 21 (CI's `Language smoke`
//! java, kotlin and python jobs):
//! `cargo test -p ide-host --test project_smoke -- --ignored`.

use ide_host::{Host, HostConfig, ops};
use ide_index::SymbolFilter;
use ide_workspace::roots::RootKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const WINDOW: &str = "main";

struct Fixture {
    dir: &'static str,
    /// Detected roots: (project-relative path, kind).
    roots: &'static [(&'static str, RootKind)],
    /// Search Everywhere › Files: (query, file found).
    file: (&'static str, &'static str),
    /// Go to Class: (name, file declaring it).
    class: (&'static str, &'static str),
    /// Go to Symbol: (name, file declaring it).
    symbol: (&'static str, &'static str),
    /// A file created while the project is open: (path, text declaring the class `FreshWidget`).
    added: (&'static str, &'static str),
}

struct Opened {
    host: Arc<Host>,
    root: PathBuf,
    _tmp: tempfile::TempDir,
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&src, &dst);
        } else {
            std::fs::copy(&src, &dst).unwrap();
        }
    }
}

async fn open(fixture: &str) -> Opened {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join(fixture);
    copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(fixture), &root);
    let app = tmp.path().join("app");
    let host = Arc::new(Host::new(HostConfig {
        config_dir: app.join("config"),
        data_dir: app.join("data"),
        local_data_dir: app.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(|_| {})),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    host.trust.decide(&root, true, false).unwrap();
    ops::project::open(&host, WINDOW, &root).await.unwrap();
    Opened { host, root, _tmp: tmp }
}

/// Polls `check` until it holds; fails with its last answer.
async fn until<T: std::fmt::Debug>(what: &str, timeout: Duration, mut check: impl FnMut() -> Result<(), T>) {
    let deadline = Instant::now() + timeout;
    loop {
        match check() {
            Ok(()) => return,
            Err(last) if Instant::now() > deadline => panic!("{what}: timed out after {timeout:?}; last: {last:?}"),
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

impl Opened {
    fn files(&self, query: &str) -> Vec<String> {
        let found = ops::nav::find_files(&self.host, WINDOW, query.into(), 20).unwrap();
        found.into_iter().map(|f| f.rel_path).collect()
    }

    fn symbols(&self, query: &str, filter: SymbolFilter) -> Vec<(String, String)> {
        let found = ops::nav::find_symbols(&self.host, WINDOW, query.into(), filter, 20).unwrap();
        found.into_iter().map(|s| (s.name, s.rel_path)).collect()
    }

    fn has_symbol(&self, name: &str, file: &str, filter: SymbolFilter) -> Result<(), Vec<(String, String)>> {
        let found = self.symbols(name, filter);
        if found.iter().any(|(n, f)| n == name && f == file) { Ok(()) } else { Err(found) }
    }
}

async fn smoke(f: Fixture) {
    let p = open(f.dir).await;
    until("indexing", Duration::from_secs(30), || {
        let s = ops::nav::index_status(&p.host, WINDOW).unwrap();
        if !s.indexing && s.files > 0 && s.symbols > 0 { Ok(()) } else { Err(s) }
    })
    .await;

    let roots = ops::project::roots(&p.host, WINDOW).unwrap().roots;
    for (path, kind) in f.roots {
        assert!(
            roots.iter().any(|r| r.path == *path && r.kind == *kind),
            "{}: no {kind:?} root {path:?} in {roots:?}",
            f.dir
        );
    }

    let files = p.files(f.file.0);
    assert!(files.iter().any(|r| r == f.file.1), "{}: files for {:?}: {files:?}", f.dir, f.file.0);
    if let Err(found) = p.has_symbol(f.class.0, f.class.1, SymbolFilter::Types) {
        panic!("{}: Go to Class {:?}: {found:?}", f.dir, f.class.0);
    }
    if let Err(found) = p.has_symbol(f.symbol.0, f.symbol.1, SymbolFilter::All) {
        panic!("{}: Go to Symbol {:?}: {found:?}", f.dir, f.symbol.0);
    }

    // The index follows the file system while the project is open.
    let (added, text) = f.added;
    std::fs::write(p.root.join(added), text).unwrap();
    until("a new file's class", Duration::from_secs(20), || p.has_symbol("FreshWidget", added, SymbolFilter::Types))
        .await;
    std::fs::remove_file(p.root.join(added)).unwrap();
    until("a deleted file's class", Duration::from_secs(20), || {
        let found = p.symbols("FreshWidget", SymbolFilter::Types);
        if found.is_empty() { Ok(()) } else { Err(found) }
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rust_app() {
    smoke(Fixture {
        dir: "rust-app",
        roots: &[("src", RootKind::Source), ("tests", RootKind::Test)],
        file: ("pars", "src/parser.rs"),
        class: ("Inventory", "src/lib.rs"),
        symbol: ("low_stock", "src/lib.rs"),
        added: ("src/fresh.rs", "pub struct FreshWidget;\n"),
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ts_app() {
    smoke(Fixture {
        dir: "ts-app",
        roots: &[("src", RootKind::Source), ("tests", RootKind::Test)],
        file: ("cart", "src/cart.ts"),
        class: ("Cart", "src/cart.ts"),
        symbol: ("formatMoney", "src/money.ts"),
        added: ("src/fresh.ts", "export class FreshWidget {}\n"),
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn python_app() {
    smoke(Fixture {
        dir: "python-app",
        roots: &[("src", RootKind::Source), ("tests", RootKind::Test)],
        file: ("models", "src/tasks/models.py"),
        class: ("TaskList", "src/tasks/models.py"),
        symbol: ("build_demo", "src/tasks/cli.py"),
        added: ("src/tasks/fresh.py", "class FreshWidget:\n    pass\n"),
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn go_app() {
    smoke(Fixture {
        dir: "go-app",
        roots: &[("", RootKind::Source)],
        file: ("store", "internal/store/store.go"),
        class: ("Store", "internal/store/store.go"),
        symbol: ("writeJSON", "cmd/server/main.go"),
        added: ("internal/store/fresh.go", "package store\n\ntype FreshWidget struct{}\n"),
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn java_app() {
    smoke(Fixture {
        dir: "java-app",
        roots: &[("src/main/java", RootKind::Source), ("src/test/java", RootKind::Test)],
        file: ("OrderBook", "src/main/java/com/example/orders/OrderBook.java"),
        class: ("OrderBook", "src/main/java/com/example/orders/OrderBook.java"),
        symbol: ("revenueCents", "src/main/java/com/example/orders/OrderBook.java"),
        added: (
            "src/main/java/com/example/orders/FreshWidget.java",
            "package com.example.orders;\n\npublic class FreshWidget {}\n",
        ),
    })
    .await;
    let p = open("java-app").await;
    let model = ops::build::build_model(&p.host, WINDOW).await.unwrap();
    let maven = model.maven.expect("a Maven model");
    assert_eq!(maven.projects.iter().map(|m| m.artifact_id.as_str()).collect::<Vec<_>>(), ["openidea-fixture-orders"]);
    assert!(maven.projects[0].dependencies.iter().any(|d| d.artifact_id == "junit-jupiter"), "{maven:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kotlin_gradle() {
    smoke(Fixture {
        dir: "kotlin-gradle",
        roots: &[("src/main/kotlin", RootKind::Source), ("src/test/kotlin", RootKind::Test)],
        file: ("Library", "src/main/kotlin/com/example/library/Library.kt"),
        class: ("Library", "src/main/kotlin/com/example/library/Library.kt"),
        symbol: ("giveBack", "src/main/kotlin/com/example/library/Library.kt"),
        added: ("src/main/kotlin/com/example/library/Fresh.kt", "package com.example.library\n\nclass FreshWidget\n"),
    })
    .await;
    let p = open("kotlin-gradle").await;
    let model = ops::build::build_model(&p.host, WINDOW).await.unwrap();
    assert_eq!(model.gradle.len(), 1, "one independent Gradle build");
    let gradle = &model.gradle[0];
    assert_eq!(gradle.projects.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(), ["openidea-fixture-library"]);
}

/// Maven / Gradle sync (Reload in the build tool window): the build's own model.
async fn sync(fixture: &str, tool: ide_build::BuildTool) -> ide_build::BuildModel {
    let p = open(fixture).await;
    let progress = ops::Channel::new(|_: ide_build::SyncProgress| {});
    let model = ops::build::build_sync(&p.host, WINDOW, tool, ide_core::RequestId(1), false, vec![], None, progress)
        .await
        .unwrap();
    // The cached sync is what the next open shows.
    let reloaded = ops::build::build_model(&p.host, WINDOW).await.unwrap();
    assert_eq!(reloaded, model);
    model
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "project smoke: needs Maven and a JDK"]
async fn maven_sync() {
    let maven = sync("java-app", ide_build::BuildTool::Maven).await.maven.unwrap();
    assert_eq!(maven.sync_error, None);
    assert!(maven.synced_at.is_some());
    let junit = maven.projects[0].dependencies.iter().find(|d| d.artifact_id == "junit-jupiter").unwrap();
    // The resolved tree, not only the declaration.
    assert!(!junit.children.is_empty(), "{junit:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "project smoke: needs Gradle and a JDK"]
async fn gradle_sync() {
    let model = sync("kotlin-gradle", ide_build::BuildTool::Gradle).await;
    assert_eq!(model.gradle.len(), 1, "one independent Gradle build");
    let gradle = &model.gradle[0];
    assert_eq!(gradle.sync_error, None);
    assert!(gradle.synced_at.is_some());
    let tasks: Vec<&str> = gradle.projects[0].tasks.iter().map(|t| t.name.as_str()).collect();
    // The build's own tasks: the application and Kotlin plugins' too.
    for task in ["run", "compileKotlin", "test"] {
        assert!(tasks.contains(&task), "no {task} in {tasks:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "project smoke: needs python3"]
async fn python_venv() {
    let p = open("python-app").await;
    let made = std::process::Command::new("python3").args(["-m", "venv", ".venv"]).current_dir(&p.root).status();
    assert!(made.unwrap().success());
    // The project's virtualenv: listed first, and the interpreter the project uses.
    let found = ops::sdk::sdk_detect(&p.host, WINDOW, ide_sdk::SdkKind::Python).await.unwrap();
    assert_eq!(found.first().map(|s| s.source.as_str()), Some("venv"), "{found:?}");
    let effective = ops::sdk::sdk_python_effective(&p.host, WINDOW, None).unwrap().expect("an interpreter");
    assert!(effective.starts_with(p.root.join(".venv")), "{effective:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "project smoke: needs JDK 21"]
async fn jdk() {
    let p = open("java-app").await;
    let found = ops::sdk::sdk_detect(&p.host, WINDOW, ide_sdk::SdkKind::Jdk).await.unwrap();
    assert!(found.iter().any(|s| s.version.as_deref().is_some_and(|v| v.starts_with("21"))), "{found:?}");
}
