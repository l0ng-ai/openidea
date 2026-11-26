//! A Maven build in an excluded folder (a `.worktrees` checkout of the same repository)
//! repeats the coordinates of the project's own build. jdtls keeps one Eclipse project per
//! name, so it must not import the excluded copy: Go to Definition and implementations would
//! otherwise land in it instead of the project's sources.
//!
//! `#[ignore]`d because it needs jdtls on `PATH` and a JDK 21+:
//! `cargo test -p ide-host --test jdtls_excluded_checkout -- --ignored`.

use ide_core::{IdeEvent, Pos};
use ide_host::{Host, HostConfig, ops};
use ide_lsp::types::GotoKind;
use ide_workspace::settings::SettingsScope;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const WINDOW: &str = "main";

fn pom(artifact: &str, deps: &str) -> String {
    format!(
        "<project xmlns=\"http://maven.apache.org/POM/4.0.0\"><modelVersion>4.0.0</modelVersion>\
         <groupId>com.x</groupId><artifactId>{artifact}</artifactId><version>1.0</version>\
         <properties><maven.compiler.release>17</maven.compiler.release></properties>\
         <dependencies>{deps}</dependencies></project>"
    )
}

fn write_lib(dir: &Path) -> std::path::PathBuf {
    let source = dir.join("src/main/java/lib/Foo.java");
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    std::fs::write(dir.join("pom.xml"), pom("lib", "")).unwrap();
    std::fs::write(&source, "package lib;\npublic class Foo {\n    public static int answer() { return 42; }\n}\n")
        .unwrap();
    source
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs jdtls on PATH and a JDK 21+"]
async fn excluded_checkout_does_not_shadow_the_projects_own_build() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    // The opened folder has no build of its own; its builds sit side by side.
    let root = base.join("workspace");
    let own = write_lib(&root.join("lib"));
    write_lib(&root.join(".worktrees/topic/lib"));
    // Only in the checkout: imported at all, it shows the folder was scanned.
    let extra = root.join(".worktrees/topic/extra");
    std::fs::create_dir_all(&extra).unwrap();
    std::fs::write(extra.join("pom.xml"), pom("extra", "")).unwrap();
    let dep = "<dependency><groupId>com.x</groupId><artifactId>lib</artifactId><version>1.0</version></dependency>";
    let app = root.join("app/src/main/java/app/App.java");
    std::fs::create_dir_all(app.parent().unwrap()).unwrap();
    std::fs::write(root.join("app/pom.xml"), pom("app", dep)).unwrap();
    std::fs::write(
        &app,
        "package app;\nimport lib.Foo;\npublic class App {\n    int run() { return Foo.answer(); }\n}\n",
    )
    .unwrap();

    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: base.join("app/config"),
        data_dir: base.join("app/data"),
        local_data_dir: base.join("app/data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new({
            let events = events.clone();
            move |_| {
                let events = events.clone();
                Arc::new(move |e: IdeEvent| events.lock().unwrap().push(e))
            }
        }),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    host.trust.decide(&root, true, false).unwrap();
    host.open_project(WINDOW, &root).unwrap();
    let set =
        |key: &str, value: &str| ops::project::set_settings(&host, WINDOW, SettingsScope::Project, key, value).unwrap();
    set("projectStructure.excluded", r#"[".worktrees"]"#);
    set("languages.java.jdtlsShared", "true");
    let repo = base.join("m2").to_string_lossy().replace('\\', "/");
    set("languages.java.maven.localRepository", &serde_json::to_string(&repo).unwrap());

    let doc = ops::doc::doc_open(&host, WINDOW, app.clone()).await.unwrap().id;
    // `Foo` in `return Foo.answer();`
    let at = Pos::new(3, 24);
    let deadline = Instant::now() + Duration::from_secs(420);
    let found = loop {
        let found = ops::lsp::lsp_goto(&host, WINDOW, doc, at, GotoKind::Definition).await;
        if let Ok(locs) = &found
            && let Some(first) = locs.first()
        {
            break first.path.0.clone();
        }
        assert!(Instant::now() < deadline, "no definition for Foo: {found:?}");
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    assert_eq!(found, own, "Foo resolved to the excluded checkout");
    let imported = imported_projects(&base.join("app/data"));
    assert!(imported.iter().any(|p| p.ends_with("/workspace/lib")), "lib not imported: {imported:?}");
    assert!(!imported.iter().any(|p| p.contains("/.worktrees/")), "imported the excluded checkout: {imported:?}");
    host.shutdown().await;
}

/// The folders of the Eclipse projects jdtls has imported, from its workspaces under `data`.
fn imported_projects(data: &Path) -> Vec<String> {
    let mut found = Vec::new();
    for entry in walkdir(data) {
        if entry.file_name().is_some_and(|n| n == ".location")
            && let Ok(bytes) = std::fs::read(&entry)
        {
            let text = String::from_utf8_lossy(&bytes);
            if let Some(at) = text.find("file:") {
                let path: String = text[at + 5..].chars().take_while(|c| !c.is_control()).collect();
                found.push(path.trim_end_matches('/').to_owned());
            }
        }
    }
    found.sort();
    found
}

fn walkdir(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() { stack.push(path) } else { out.push(path) }
        }
    }
    out
}
