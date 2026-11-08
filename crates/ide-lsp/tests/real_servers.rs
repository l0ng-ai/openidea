//! Integration tests against real language servers. The server tests are
//! `#[ignore]`d; run with `cargo test -p ide-lsp --test real_servers -- --ignored`.

use ide_core::event::ServerStatus;
use ide_core::{DocId, IdeEvent, LanguageId, Pos, Range};
use ide_language::{LanguageConfig, LanguageRegistry, LanguageServerConfig};
use ide_lsp::LspManager;
use ide_lsp::types::GotoKind;
use ide_text::AppliedChange;
use parking_lot::Mutex;
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

type Events = Arc<Mutex<Vec<IdeEvent>>>;

fn manager(root: &Path, registry: LanguageRegistry) -> (Arc<LspManager>, Events) {
    let events: Events = Arc::default();
    let sink = {
        let events = events.clone();
        Arc::new(move |e: IdeEvent| events.lock().push(e))
    };
    (LspManager::new(root.to_path_buf(), Arc::new(registry), sink), events)
}

fn last_status(events: &Events, name: &str) -> Option<(ServerStatus, Option<String>)> {
    events.lock().iter().rev().find_map(|e| match e {
        IdeEvent::LanguageServer { name: n, status, message, .. } if n == name => Some((*status, message.clone())),
        _ => None,
    })
}

/// Retries `f` until it yields `Some` (servers answer emptily while indexing).
async fn retry<T, F: Future<Output = Option<T>>>(what: &str, timeout: Duration, mut f: impl FnMut() -> F) -> T {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(v) = f().await {
            return v;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn lang(id: &str, ext: &str, server: LanguageServerConfig) -> LanguageConfig {
    LanguageConfig {
        id: LanguageId::new(id),
        name: id.into(),
        extensions: vec![ext.into()],
        filenames: vec![],
        first_line: None,
        line_comment: None,
        block_comment: None,
        indent: None,
        ui_mode: None,
        framework_ui_modes: Vec::new(),
        formatter: None,
        scratch_template: None,
        tree_sitter: None,
        language_servers: vec![server],
        debugger: None,
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires kmp-lsp on PATH (or OPENIDEA_TEST_KMP_LSP)"]
async fn kmp_lsp_java_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let path = root.join("Sample.java");
    let source = "class Sample {\n    static String greet() { return \"Hello\"; }\n    void run() { greet(); }\n}\n";
    std::fs::write(&path, source).unwrap();
    let mut java = LanguageRegistry::load(None).unwrap().get(&LanguageId::new("java")).unwrap();
    java.language_servers.retain(|s| s.name == "kmp-lsp");
    assert_eq!(java.language_servers.len(), 1);
    if let Ok(bin) = std::env::var("OPENIDEA_TEST_KMP_LSP") {
        java.language_servers[0].command = bin;
    }
    let (mgr, events) = manager(&root, LanguageRegistry::from_configs(vec![java]));
    let doc = DocId::next();
    mgr.did_open(doc, &path, &LanguageId::new("java"), 1, source);
    retry("kmp-lsp ready", Duration::from_secs(30), || {
        let status = last_status(&events, "kmp-lsp");
        if let Some((ServerStatus::Crashed | ServerStatus::Missing | ServerStatus::Misconfigured, msg)) = &status {
            panic!("kmp-lsp failed: {msg:?}");
        }
        async move { matches!(status, Some((ServerStatus::Ready | ServerStatus::Busy, _))).then_some(()) }
    })
    .await;
    let hover = retry("Java hover", Duration::from_secs(30), || async {
        mgr.hover(doc, Pos::new(2, 18), Default::default()).await.ok().flatten()
    })
    .await;
    assert!(hover.contents.value.contains("greet"), "{}", hover.contents.value);
    let defs = retry("Java definition", Duration::from_secs(30), || async {
        mgr.goto(doc, Pos::new(2, 18), GotoKind::Definition).await.ok().filter(|d| !d.is_empty())
    })
    .await;
    assert_eq!(defs[0].path, path);
    assert_eq!(defs[0].range.start.line, 1);
    retry("Java completion", Duration::from_secs(30), || async {
        let list = mgr.completion(doc, Pos::new(2, 20), None, Default::default()).await.ok()?;
        list.items.iter().any(|i| i.label.starts_with("greet")).then_some(())
    })
    .await;
    let tokens = mgr.semantic_tokens(doc).await.unwrap().unwrap();
    assert!(!tokens.data.is_empty() && tokens.data.len() % 5 == 0);
    let error = mgr.java_debug_server(&path).await.unwrap_err();
    assert_eq!(error.kind, ide_core::error::ErrorKind::Unavailable);
    assert!(error.message.contains("jdtls"));
    tokio::time::timeout(Duration::from_secs(10), mgr.shutdown_all()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires jdtls on PATH and a compatible JDK"]
async fn java_searches_skip_indexed_sources_but_keep_exclusions_outside_scope() {
    use ide_lsp::types::HierarchyDirection;
    use serde_json::json;

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let root = dunce::canonicalize(root).unwrap();
    std::fs::create_dir_all(root.join("src/demo/excluded")).unwrap();
    std::fs::write(root.join(".project"), "<projectDescription><name>search-scope</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>").unwrap();
    std::fs::write(root.join(".classpath"), "<classpath><classpathentry kind=\"src\" path=\"src\" excluding=\"demo/excluded/**\"/><classpathentry kind=\"con\" path=\"org.eclipse.jdt.launching.JRE_CONTAINER\"/><classpathentry kind=\"output\" path=\"bin\"/></classpath>").unwrap();
    let source = "package demo; public class Target { public static void target() {} }";
    let path = root.join("src/demo/Target.java");
    let caller = root.join("src/demo/Caller.java");
    let decoy = root.join("src/demo/Decoy.java");
    let excluded = root.join("src/demo/excluded/Excluded.java");
    let outside = root.join("Outside.java");
    std::fs::write(&path, source).unwrap();
    std::fs::write(&caller, "package demo; class Caller { void call() { Target.target(); } }").unwrap();
    // A source file mentioning the name without a usage, too large for transient opening.
    std::fs::write(&decoy, format!("package demo; class Decoy {{ void target() {{}} }}\n/*{}*/", " ".repeat(1 << 20)))
        .unwrap();
    std::fs::write(&excluded, "package demo.excluded; class Excluded {}").unwrap();
    std::fs::write(&outside, "class Outside {}").unwrap();
    let mut java = LanguageRegistry::load(None).unwrap().get(&LanguageId::new("java")).unwrap();
    java.language_servers.retain(|s| s.name == "jdtls");
    let server = &mut java.language_servers[0];
    if let Ok(bin) = std::env::var("OPENIDEA_TEST_JDTLS") {
        server.command = bin;
    }
    server.args.extend(["-data".into(), dir.path().join("metadata").to_string_lossy().into_owned()]);
    let bundle = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../java/java-usages/openidea-java-usages.jar");
    server
        .initialization_options
        .as_mut()
        .unwrap()
        .as_table_mut()
        .unwrap()
        .insert("bundles".into(), toml::Value::Array(vec![toml::Value::String(bundle.to_string_lossy().into_owned())]));
    let (mgr, _) = manager(&root, LanguageRegistry::from_configs(vec![java]));
    let doc = DocId::next();
    mgr.did_open(doc, &path, &LanguageId::new("java"), 1, source);
    mgr.java_build(&path, false, &Default::default()).await.unwrap();
    let uri = ide_lsp::path_to_uri_string;
    let covered = retry("imported source scope", Duration::from_secs(120), || async {
        mgr.jdtls_command(
            &path,
            "openidea.workspace.coveredFiles",
            vec![json!([uri(&caller), uri(&decoy), uri(&excluded), uri(&outside),])],
        )
        .await
        .ok()
        .filter(|v| v.as_array().is_some_and(|a| !a.is_empty()))
    })
    .await;
    assert_eq!(covered, json!([uri(&caller), uri(&decoy)]));
    mgr.set_candidates_hook(Box::new(move |_, _| ide_lsp::CandidateFiles {
        files: vec![caller.clone(), decoy.clone()],
        limit_hit: false,
    }));
    let at = Pos::new(0, source.find("target()").unwrap() as u32);
    let refs = mgr.references_streaming(doc, at, false, true, false, Default::default(), None).await.unwrap();
    assert_eq!(refs.locations.len(), 1);
    assert!(refs.locations[0].path.ends_with("Caller.java"));
    assert_eq!(refs.incomplete, None, "the indexed decoy must not be transiently opened");
    let calls = mgr.call_hierarchy(doc, at, HierarchyDirection::Incoming, Default::default()).await.unwrap();
    assert_eq!(calls.items.len(), 1);
    assert!(calls.items[0].path.ends_with("Caller.java"));
    assert_eq!(calls.incomplete, None);
    mgr.shutdown_all().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires jdtls on PATH and a compatible JDK"]
async fn lombok_generated_members_appear_in_document_symbols() {
    let dir = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(dir.path()).unwrap();
    let source = include_str!("fixtures/LombokSymbols.java");
    let path = root.join("src/demo/LombokSymbols.java");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, source).unwrap();
    let agent = dunce::canonicalize(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../java/lombok/lombok-1.18.48-openidea.3.jar"),
    )
    .unwrap();
    std::fs::write(
        root.join(".project"),
        "<projectDescription><name>lombok-symbols</name><buildSpec><buildCommand>\
         <name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures>\
         <nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>",
    )
    .unwrap();
    let library = agent.to_string_lossy().replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;");
    std::fs::write(
        root.join(".classpath"),
        format!(
            "<classpath><classpathentry kind=\"src\" path=\"src\"/>\
             <classpathentry kind=\"con\" path=\"org.eclipse.jdt.launching.JRE_CONTAINER\"/>\
             <classpathentry kind=\"lib\" path=\"{library}\"/>\
             <classpathentry kind=\"output\" path=\"bin\"/></classpath>"
        ),
    )
    .unwrap();
    let mut java = LanguageRegistry::load(None).unwrap().get(&LanguageId::new("java")).unwrap();
    java.language_servers.retain(|s| s.name == "jdtls");
    let server = &mut java.language_servers[0];
    if let Ok(bin) = std::env::var("OPENIDEA_TEST_JDTLS") {
        server.command = bin;
    }
    server.args.extend([
        "-data".into(),
        root.join("workspace").to_string_lossy().into_owned(),
        format!("--jvm-arg=-javaagent:{}", agent.display()),
    ]);
    let (mgr, _) = manager(&root, LanguageRegistry::from_configs(vec![java]));
    let doc = DocId::next();
    mgr.did_open(doc, &path, &LanguageId::new("java"), 1, source);
    let expected: &[(&str, &[&str])] = &[
        ("User", &["getName()", "setName(String)", "getAge()", "setAge(int)", "User(String, int)", "builder()"]),
        ("UserBuilder", &["name(String)", "age(int)", "build()"]),
        ("Profile", &["Profile(String)", "getId()", "getName()", "setName(String)"]),
        ("Logged", &["log", "write()"]),
        ("PlainUser", &["PlainUser(String)", "getName()", "setName(String)"]),
    ];
    fn has_members(items: &[ide_core::OutlineItem], owner: &str, names: &[&str]) -> bool {
        items.iter().any(|item| {
            (item.name == owner && names.iter().all(|n| item.children.iter().any(|c| c.name == *n)))
                || has_members(&item.children, owner, names)
        })
    }
    retry("Lombok document symbols", Duration::from_secs(120), || async {
        let items = mgr.document_symbols(doc).await.ok().flatten()?;
        expected.iter().all(|(owner, names)| has_members(&items, owner, names)).then_some(())
    })
    .await;
    tokio::time::timeout(Duration::from_secs(10), mgr.shutdown_all()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires jdtls on PATH and a compatible JDK"]
async fn intellij_java_formatter_preserves_manual_breaks_and_wraps_long_lines() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let source = include_str!("fixtures/FormatterSample.input.java");
    let expected = include_str!("fixtures/FormatterSample.intellij.java");
    let path = root.join("src/demo/FormatterSample.java");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, source).unwrap();
    let mut java = LanguageRegistry::load(None).unwrap().get(&LanguageId::new("java")).unwrap();
    let server = &mut java.language_servers[0];
    if let Ok(bin) = std::env::var("OPENIDEA_TEST_JDTLS") {
        server.command = bin;
    }
    server.args.extend(["-data".into(), root.join("jdtls-workspace").to_string_lossy().into_owned()]);
    server.settings = Some(serde_json::json!({"java": {"autobuild": {"enabled": false}}}));
    let (mgr, events) = manager(&root, LanguageRegistry::from_configs(vec![java]));
    mgr.set_config_hook(Box::new({
        let root = root.clone();
        move |cfg, _| {
            ide_lsp::jdtls::configure_source_paths(cfg, Some(vec!["src".into()]));
            let style = ide_core::editor_settings::LanguageCodeStyle {
                formatter: Some("intellij".into()),
                ..Default::default()
            };
            ide_lsp::jdtls::configure_formatter(cfg, Some(&style), &root, &root.join("data"), None).unwrap();
        }
    }));
    let doc = DocId::next();
    mgr.did_open(doc, &path, &LanguageId::new("java"), 1, source);
    retry("jdtls ready", Duration::from_secs(120), || {
        let status = last_status(&events, "jdtls");
        if let Some((ServerStatus::Crashed | ServerStatus::Missing | ServerStatus::Misconfigured, msg)) = &status {
            panic!("jdtls failed: {msg:?}");
        }
        async move { matches!(status, Some((ServerStatus::Ready | ServerStatus::Busy, _))).then_some(()) }
    })
    .await;
    let edits = mgr
        .format(
            doc,
            None,
            ide_lsp::types::FormatOptions { tab_size: 4, insert_spaces: true, on_save: false, tool: None },
        )
        .await;
    tokio::time::timeout(Duration::from_secs(10), mgr.shutdown_all()).await.unwrap();
    let mut document = ide_text::Document::new(source);
    document.apply_edits(&edits.unwrap()).unwrap();
    assert_eq!(document.text(), expected);
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_binary_is_reported_with_install_hint() {
    let dir = tempfile::tempdir().unwrap();
    let server = LanguageServerConfig {
        name: "nope-ls".into(),
        command: "openidea-definitely-not-installed-ls".into(),
        args: vec![],
        env: Default::default(),
        root_markers: vec![],
        require_root_marker: false,
        initialization_options: None,
        settings: None,
        install_hint: Some("npm i -g nope-ls".into()),
        connect: None,
        fallback: false,
        features: Vec::new(),
        code_action_kinds: Vec::new(),
        max_java: None,
        launch_error: None,
        tsserver_project: false,
        tsserver_project_extras: Default::default(),
        resync_on_configuration: false,
        pinned: None,
    };
    let (mgr, events) = manager(dir.path(), LanguageRegistry::from_configs(vec![lang("nope", "nope", server)]));
    let path = dir.path().join("a.nope");
    mgr.did_open(DocId::next(), &path, &LanguageId::new("nope"), 1, "x");
    retry("missing status", Duration::from_secs(10), || {
        let s = last_status(&events, "nope-ls");
        async move { (s.as_ref().map(|s| s.0) == Some(ServerStatus::Missing)).then_some(()) }
    })
    .await;
    assert_eq!(last_status(&events, "nope-ls").unwrap().1.as_deref(), Some("npm i -g nope-ls"));
}

const MAIN_RS: &str = "struct Point {
    x: i32,
    y: i32,
}

/// Adds two numbers.
fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn main() {
    let p = Point { x: 1, y: 2 };
    let s = add(p.x, p.y);
    println!(\"{s}\");
}
";

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ty on PATH"]
async fn ty_python_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let path = root.join("example.py");
    let source = "def greet(name: str) -> str:\n    return name\n\nresult = greet('Ada')\nbad: int = 'wrong'\n";
    std::fs::write(&path, source).unwrap();
    let mut python = LanguageRegistry::load(None).unwrap().get(&LanguageId::new("python")).unwrap();
    python.language_servers.retain(|server| server.name == "ty");
    assert_eq!(python.language_servers.len(), 1);
    let (mgr, events) = manager(&root, LanguageRegistry::from_configs(vec![python]));
    let doc = DocId::next();
    mgr.did_open(doc, &path, &LanguageId::new("python"), 1, source);
    retry("ty ready", Duration::from_secs(30), || {
        let status = last_status(&events, "ty");
        if let Some((ServerStatus::Crashed | ServerStatus::Missing | ServerStatus::Misconfigured, msg)) = &status {
            panic!("ty failed: {msg:?}");
        }
        async move { matches!(status, Some((ServerStatus::Ready | ServerStatus::Busy, _))).then_some(()) }
    })
    .await;
    let defs = retry("ty definition", Duration::from_secs(30), || {
        let mgr = mgr.clone();
        async move { mgr.goto(doc, Pos::new(3, 10), GotoKind::Definition).await.ok().filter(|d| !d.is_empty()) }
    })
    .await;
    assert_eq!(defs[0].path, path);
    assert_eq!(defs[0].range.start.line, 0);
    retry("ty diagnostics", Duration::from_secs(30), || {
        let found = events.lock().iter().any(
            |event| matches!(event, IdeEvent::Diagnostics { source, items, .. } if source == "ty" && !items.is_empty()),
        );
        async move { found.then_some(()) }
    })
    .await;
}

/// Ruff next to basedpyright in a project configured for Ruff: its lint
/// diagnostics, the only formatter and the only Organize Imports and Fix All.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires ruff and basedpyright on PATH"]
async fn ruff_next_to_basedpyright_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::write(root.join("pyproject.toml"), "[tool.ruff.lint]\nselect = [\"F\", \"I\"]\n").unwrap();
    let path = root.join("example.py");
    let source = "import sys\nimport os\n\nx  =  os.getcwd( )\n";
    std::fs::write(&path, source).unwrap();
    let mut python = LanguageRegistry::load(None).unwrap().get(&LanguageId::new("python")).unwrap();
    python.language_servers.retain(|server| matches!(server.name.as_str(), "basedpyright" | "ruff"));
    assert_eq!(python.language_servers.len(), 2);
    let (mgr, events) = manager(&root, LanguageRegistry::from_configs(vec![python]));
    let doc = DocId::next();
    mgr.did_open(doc, &path, &LanguageId::new("python"), 1, source);
    for name in ["basedpyright", "ruff"] {
        retry(name, Duration::from_secs(60), || {
            let status = last_status(&events, name);
            if let Some((ServerStatus::Crashed | ServerStatus::Missing | ServerStatus::Misconfigured, msg)) = &status {
                panic!("{name} failed: {msg:?}");
            }
            async move { matches!(status, Some((ServerStatus::Ready | ServerStatus::Busy, _))).then_some(()) }
        })
        .await;
    }
    // F401 (`sys` unused) and I001 (unsorted imports).
    let codes = retry("ruff diagnostics", Duration::from_secs(30), || {
        let codes: Option<Vec<String>> = events.lock().iter().rev().find_map(|e| match e {
            IdeEvent::Diagnostics { source, items, .. } if source == "ruff" && !items.is_empty() => {
                Some(items.iter().filter_map(|d| d.code.clone()).collect())
            }
            _ => None,
        });
        async move { codes }
    })
    .await;
    assert!(codes.iter().any(|c| c == "F401") && codes.iter().any(|c| c == "I001"), "{codes:?}");

    let options = ide_lsp::types::FormatOptions { tab_size: 4, insert_spaces: true, on_save: false, tool: None };
    let edits = mgr.format(doc, None, options).await.unwrap();
    assert!(!edits.is_empty() && edits.iter().all(|e| e.range.start.line == 3), "{edits:?}");

    let whole = Range::new(Pos::new(0, 0), Pos::new(4, 0));
    for kind in ["source.organizeImports", "source.fixAll"] {
        let actions = mgr.code_actions(doc, whole, vec![kind.into()]).await.unwrap();
        let kinds: Vec<&str> = actions.iter().filter_map(|a| a.kind.as_deref()).collect();
        assert_eq!(kinds, [format!("{kind}.ruff")], "{actions:?}");
        let action = mgr.resolve_code_action(doc, actions[0].clone()).await.unwrap();
        let edit = action.edit.expect("an edit");
        assert!(!edited_lines(&edit, &path).is_empty(), "{edit:?}");
    }
    tokio::time::timeout(Duration::from_secs(10), mgr.shutdown_all()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires pyrefly on PATH"]
async fn pyrefly_python_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let path = root.join("example.py");
    let source = "def greet(name: str) -> str:\n    return name\n\nresult = greet('Ada')\nbad: int = 'wrong'\n";
    std::fs::write(&path, source).unwrap();
    // Pyrefly only reports type errors in projects with a Pyrefly configuration.
    std::fs::write(root.join("pyrefly.toml"), "").unwrap();
    let mut python = LanguageRegistry::load(None).unwrap().get(&LanguageId::new("python")).unwrap();
    python.language_servers.retain(|server| server.name == "pyrefly");
    assert_eq!(python.language_servers.len(), 1);
    let (mgr, events) = manager(&root, LanguageRegistry::from_configs(vec![python]));
    let doc = DocId::next();
    mgr.did_open(doc, &path, &LanguageId::new("python"), 1, source);
    retry("pyrefly ready", Duration::from_secs(30), || {
        let status = last_status(&events, "pyrefly");
        if let Some((ServerStatus::Crashed | ServerStatus::Missing | ServerStatus::Misconfigured, msg)) = &status {
            panic!("pyrefly failed: {msg:?}");
        }
        async move { matches!(status, Some((ServerStatus::Ready | ServerStatus::Busy, _))).then_some(()) }
    })
    .await;
    let defs = retry("pyrefly definition", Duration::from_secs(30), || {
        let mgr = mgr.clone();
        async move { mgr.goto(doc, Pos::new(3, 10), GotoKind::Definition).await.ok().filter(|d| !d.is_empty()) }
    })
    .await;
    assert_eq!(defs[0].path, path);
    assert_eq!(defs[0].range.start.line, 0);
    retry("pyrefly diagnostics", Duration::from_secs(30), || {
        let found = events.lock().iter().any(
            |event| matches!(event, IdeEvent::Diagnostics { source, items, .. } if source == "pyrefly" && !items.is_empty()),
        );
        async move { found.then_some(()) }
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires rust-analyzer"]
async fn rust_analyzer_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::write(root.join("Cargo.toml"), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n")
        .unwrap();
    std::fs::create_dir_all(root.join("src")).unwrap();
    let main = root.join("src/main.rs");
    std::fs::write(&main, MAIN_RS).unwrap();

    // `OPENIDEA_TEST_RUST_ANALYZER` overrides the binary (e.g. when the rustup proxy
    // has no rust-analyzer component for the default toolchain).
    let mut rust = LanguageRegistry::load(None).unwrap().get(&LanguageId::new("rust")).unwrap();
    if let Ok(bin) = std::env::var("OPENIDEA_TEST_RUST_ANALYZER") {
        rust.language_servers[0].command = bin;
    }
    let (mgr, events) = manager(&root, LanguageRegistry::from_configs(vec![rust]));
    let doc = DocId::next();
    mgr.did_open(doc, &main, &LanguageId::new("rust"), 1, MAIN_RS);
    retry("rust-analyzer ready", Duration::from_secs(60), || {
        let s = last_status(&events, "rust-analyzer");
        if let Some((ServerStatus::Crashed | ServerStatus::Missing | ServerStatus::Misconfigured, msg)) = &s {
            panic!("rust-analyzer failed: {msg:?}");
        }
        async move { matches!(s, Some((ServerStatus::Ready | ServerStatus::Busy, _))).then_some(()) }
    })
    .await;
    let servers = mgr.servers();
    assert_eq!(servers[0].root, root);

    // Hover over `add` in `add(p.x, p.y)` (line 12, col 12).
    let hover = retry("hover", Duration::from_secs(120), || {
        let mgr = mgr.clone();
        async move { mgr.hover(doc, Pos::new(12, 13), Default::default()).await.ok().flatten() }
    })
    .await;
    assert!(hover.contents.value.contains("fn add"), "{}", hover.contents.value);
    assert!(hover.contents.value.contains("Adds two numbers"));

    let defs = retry("definition", Duration::from_secs(60), || {
        let mgr = mgr.clone();
        async move { mgr.goto(doc, Pos::new(12, 13), GotoKind::Definition).await.ok().filter(|d| !d.is_empty()) }
    })
    .await;
    assert_eq!(defs[0].path, main);
    assert_eq!(defs[0].range.start.line, 6);

    // Type `p.` on a new line inside main and complete fields.
    let insert_at = Pos::new(13, 0);
    mgr.did_change(
        doc,
        2,
        &[AppliedChange { range: Range::point(insert_at), text: "    p.\n".into() }],
        &|| unreachable!(),
    );
    let list = retry("completion", Duration::from_secs(60), || {
        let mgr = mgr.clone();
        async move {
            let list = mgr.completion(doc, Pos::new(13, 6), Some(".".into()), Default::default()).await.ok()?;
            list.items.iter().any(|i| i.label == "x").then_some(list)
        }
    })
    .await;
    let x = list.items.iter().find(|i| i.label == "x").unwrap();
    assert_eq!(x.replace_range.map(|r| r.start), Some(Pos::new(13, 6)));
    let resolved = mgr.resolve_completion(doc, x.clone()).await.unwrap();
    assert_eq!(resolved.label, "x");

    let symbols = mgr.document_symbols(doc).await.unwrap().unwrap();
    assert!(symbols.iter().any(|s| s.name == "add"));
    let tokens = mgr.semantic_tokens(doc).await.unwrap().unwrap();
    assert!(!tokens.data.is_empty() && tokens.data.len() % 5 == 0);

    tokio::time::timeout(Duration::from_secs(10), mgr.shutdown_all()).await.unwrap();
    assert_eq!(last_status(&events, "rust-analyzer").unwrap().0, ServerStatus::Stopped);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires typescript-language-server"]
async fn typescript_language_server_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::write(root.join("tsconfig.json"), "{ \"compilerOptions\": { \"strict\": true } }").unwrap();
    let file = root.join("a.ts");
    let text =
        "export function greet(name: string): string {\n  return `hi ${name}`;\n}\nconst n: number = greet(\"x\");\n";
    std::fs::write(&file, text).unwrap();
    let server = LanguageServerConfig {
        name: "typescript-language-server".into(),
        command: "typescript-language-server".into(),
        args: vec!["--stdio".into()],
        env: Default::default(),
        root_markers: vec!["tsconfig.json".into()],
        require_root_marker: false,
        initialization_options: None,
        settings: None,
        install_hint: None,
        connect: None,
        fallback: false,
        features: Vec::new(),
        code_action_kinds: Vec::new(),
        max_java: None,
        launch_error: None,
        tsserver_project: false,
        tsserver_project_extras: Default::default(),
        resync_on_configuration: false,
        pinned: None,
    };
    let (mgr, events) = manager(&root, LanguageRegistry::from_configs(vec![lang("typescript", "ts", server)]));
    let doc = DocId::next();
    mgr.did_open(doc, &file, &LanguageId::new("typescript"), 1, text);

    let hover = retry("hover", Duration::from_secs(60), || {
        let mgr = mgr.clone();
        async move { mgr.hover(doc, Pos::new(3, 19), Default::default()).await.ok().flatten() }
    })
    .await;
    assert!(hover.contents.value.contains("greet"), "{}", hover.contents.value);

    let defs = mgr.goto(doc, Pos::new(3, 19), GotoKind::Definition).await.unwrap();
    assert_eq!(defs[0].path, file);
    assert_eq!(defs[0].range.start.line, 0);

    // Type error: string assigned to number.
    retry("diagnostics", Duration::from_secs(30), || {
        let found = events
            .lock()
            .iter()
            .any(|e| matches!(e, IdeEvent::Diagnostics { path, items, .. } if path == &file && !items.is_empty()));
        async move { found.then_some(()) }
    })
    .await;
    tokio::time::timeout(Duration::from_secs(10), mgr.shutdown_all()).await.unwrap();
}

const APP_VUE: &str = "<script setup lang=\"ts\">\nconst count: number = 1\n</script>\n\n<template>\n  <div>{{ count }}</div>\n</template>\n";

fn npm_server(tools: &Path, name: &str, bin: &str, init: Option<serde_json::Value>) -> LanguageServerConfig {
    LanguageServerConfig {
        name: name.into(),
        command: tools.join("node_modules/.bin").join(bin).to_string_lossy().into_owned(),
        args: vec!["--stdio".into()],
        env: Default::default(),
        root_markers: vec!["package.json".into()],
        require_root_marker: false,
        initialization_options: init.map(|v| toml::Value::try_from(v).unwrap()),
        settings: None,
        install_hint: None,
        connect: None,
        fallback: false,
        features: Vec::new(),
        code_action_kinds: Vec::new(),
        max_java: None,
        launch_error: None,
        tsserver_project: false,
        tsserver_project_extras: Default::default(),
        resync_on_configuration: false,
        pinned: None,
    }
}

/// Vue Language Server 3 in hybrid mode: its `tsserver/request`s go through the
/// client to vtsls with `@vue/typescript-plugin` (issue #25). Set
/// `OPENIDEA_TEST_NPM_TOOLS` to a dir with `npm i @vue/language-server typescript@6 @vtsls/language-server`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires @vue/language-server and @vtsls/language-server (OPENIDEA_TEST_NPM_TOOLS)"]
async fn vue_hybrid_mode_end_to_end() {
    let tools = std::path::PathBuf::from(std::env::var("OPENIDEA_TEST_NPM_TOOLS").expect("OPENIDEA_TEST_NPM_TOOLS"));
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::write(root.join("package.json"), "{\"name\":\"app\",\"private\":true}").unwrap();
    std::fs::write(root.join("tsconfig.json"), "{\"compilerOptions\":{\"strict\":true},\"include\":[\"src/**/*\"]}")
        .unwrap();
    std::fs::create_dir_all(root.join("src")).unwrap();
    let file = root.join("src/App.vue");
    std::fs::write(&file, APP_VUE).unwrap();

    let plugin = serde_json::json!({ "vtsls": { "tsserver": { "globalPlugins": [{
        "name": "@vue/typescript-plugin",
        "location": tools.join("node_modules/@vue/language-server").to_string_lossy(),
        "languages": ["vue"],
        "configNamespace": "typescript",
        "enableForWorkspaceTypeScriptVersions": true,
    }] } } });
    for with_vtsls in [false, true] {
        let mut vue = lang("vue", "vue", npm_server(&tools, "vue-language-server", "vue-language-server", None));
        if with_vtsls {
            vue.language_servers.push(npm_server(&tools, "vtsls", "vtsls", Some(plugin.clone())));
        }
        let (mgr, events) = manager(&root, LanguageRegistry::from_configs(vec![vue]));
        let doc = DocId::next();
        mgr.did_open(doc, &file, &LanguageId::new("vue"), 1, APP_VUE);
        // `count` in `{{ count }}`.
        let pos = Pos::new(5, 12);
        if with_vtsls {
            let hover = retry("hover", Duration::from_secs(90), || {
                let mgr = mgr.clone();
                async move { mgr.hover(doc, pos, Default::default()).await.ok().flatten() }
            })
            .await;
            assert!(hover.contents.value.contains("count: number"), "{}", hover.contents.value);
        }
        retry("vue-language-server ready", Duration::from_secs(30), || {
            let s = last_status(&events, "vue-language-server");
            async move { matches!(s, Some((ServerStatus::Ready | ServerStatus::Busy, _))).then_some(()) }
        })
        .await;
        // Every request of vue-language-server waits for a tsserver answer (the
        // project info); without vtsls it is `null` and the server falls back.
        let symbols = tokio::time::timeout(Duration::from_secs(20), mgr.document_symbols(doc)).await;
        assert!(matches!(symbols, Ok(Ok(_))), "vue-language-server did not answer: {symbols:?}");
        let crashed = matches!(last_status(&events, "vue-language-server"), Some((ServerStatus::Crashed, _)));
        assert!(!crashed, "{:?}", last_status(&events, "vue-language-server"));
        tokio::time::timeout(Duration::from_secs(10), mgr.shutdown_all()).await.unwrap();
    }
}

const NG_APP_TS: &str = "import { Component } from '@angular/core';\n\n@Component({\n  selector: 'app-root',\n  templateUrl: './app.html',\n})\nexport class App {\n  title = 'demo';\n}\n";
const NG_APP_HTML: &str = "<h1>{{ title }}</h1>\n<p>{{ missing }}</p>\n";
const NG_INLINE_TS: &str = "import { Component } from '@angular/core';\n\n@Component({\n  selector: 'app-inline',\n  template: `<b>{{ count }}</b>`,\n})\nexport class Inline {\n  count = 1;\n}\n";

/// The lines `edit` changes in `path`, in order.
fn edited_lines(edit: &ide_core::WorkspaceEdit, path: &Path) -> Vec<u32> {
    let mut lines: Vec<u32> = edit
        .files
        .iter()
        .filter_map(|f| match f {
            ide_core::FileEdit::Edit { path: p, edits, .. } if p.to_path_buf() == path => {
                Some(edits.iter().map(|e| e.range.start.line))
            }
            _ => None,
        })
        .flatten()
        .collect();
    lines.sort();
    lines
}

/// The Angular Language Server next to vtsls, in an external and an inline
/// template. Set `OPENIDEA_TEST_NPM_TOOLS` to a dir with `npm i
/// @angular/language-server @vtsls/language-server @angular/core @angular/common
/// @angular/compiler rxjs`; the project is created inside it, so that it
/// resolves `@angular/core`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires @angular/language-server, @vtsls/language-server and @angular/core (OPENIDEA_TEST_NPM_TOOLS)"]
async fn angular_language_server_end_to_end() {
    let tools = std::path::PathBuf::from(std::env::var("OPENIDEA_TEST_NPM_TOOLS").expect("OPENIDEA_TEST_NPM_TOOLS"));
    let dir = tempfile::tempdir_in(&tools).unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::write(root.join("angular.json"), "{\"version\":1,\"projects\":{}}").unwrap();
    std::fs::write(
        root.join("tsconfig.json"),
        "{\"compilerOptions\":{\"strict\":true},\"angularCompilerOptions\":{\"strictTemplates\":true},\"include\":[\"src/**/*.ts\"]}",
    )
    .unwrap();
    std::fs::create_dir_all(root.join("src/app")).unwrap();
    let app_ts = root.join("src/app/app.ts");
    let app_html = root.join("src/app/app.html");
    let inline_ts = root.join("src/app/inline.ts");
    for (path, text) in [(&app_ts, NG_APP_TS), (&app_html, NG_APP_HTML), (&inline_ts, NG_INLINE_TS)] {
        std::fs::write(path, text).unwrap();
    }

    // The built-in definitions, with vtsls and the Angular server, and the probe
    // locations the settings hook adds.
    let builtin = LanguageRegistry::load(None).unwrap();
    let probes = tools.join("node_modules/@angular/language-server").to_string_lossy().into_owned();
    let languages = ["typescript", "html"].map(|id| {
        let mut cfg = builtin.get(&LanguageId::new(id)).unwrap();
        cfg.language_servers.retain(|s| s.name == "angular-language-server" || s.name == "vtsls");
        for server in &mut cfg.language_servers {
            let bin = if server.name == "vtsls" { "vtsls" } else { "ngserver" };
            server.command = tools.join("node_modules/.bin").join(bin).to_string_lossy().into_owned();
        }
        let server = cfg.language_servers.iter_mut().find(|s| s.name == "angular-language-server").unwrap();
        server.args.extend(["--ngProbeLocations".into(), probes.clone(), "--tsProbeLocations".into(), probes.clone()]);
        cfg
    });
    let (mgr, events) = manager(&root, LanguageRegistry::from_configs(languages.to_vec()));
    let (html, ts, inline) = (DocId::next(), DocId::next(), DocId::next());
    mgr.did_open(ts, &app_ts, &LanguageId::new("typescript"), 1, NG_APP_TS);
    mgr.did_open(html, &app_html, &LanguageId::new("html"), 1, NG_APP_HTML);
    mgr.did_open(inline, &inline_ts, &LanguageId::new("typescript"), 1, NG_INLINE_TS);

    // `title` in `{{ title }}`.
    let hover = retry("hover", Duration::from_secs(90), || {
        let mgr = mgr.clone();
        async move { mgr.hover(html, Pos::new(0, 8), Default::default()).await.ok().flatten() }
    })
    .await;
    assert!(hover.contents.value.contains("title"), "{}", hover.contents.value);
    let defs = mgr.goto(html, Pos::new(0, 8), GotoKind::Definition).await.unwrap();
    assert_eq!(defs[0].path, app_ts);
    assert_eq!(defs[0].range.start.line, 7);

    // `missing` is no member of `App`.
    retry("template diagnostics", Duration::from_secs(60), || {
        let found = events
            .lock()
            .iter()
            .any(|e| matches!(e, IdeEvent::Diagnostics { path, items, .. } if path == &app_html && !items.is_empty()));
        async move { found.then_some(()) }
    })
    .await;

    // `count` in the inline template, which vtsls can't rename: renamed there
    // and in the class.
    let count = Pos::new(4, 20);
    let range = mgr.prepare_rename(inline, count).await.unwrap();
    assert_eq!(range, Some(Range::new(Pos::new(4, 19), Pos::new(4, 24))));
    let edit = mgr.rename(inline, count, "total".into(), Default::default()).await.unwrap().edit;
    assert_eq!(edited_lines(&edit, &inline_ts), [4, 7], "{edit:?}");

    // `title` in the class, which both servers rename: vtsls's edit and the
    // template's from the Angular server.
    let title = Pos::new(7, 3);
    let edit = mgr.rename(ts, title, "heading".into(), Default::default()).await.unwrap().edit;
    assert_eq!((edited_lines(&edit, &app_ts), edited_lines(&edit, &app_html)), (vec![7], vec![0]), "{edit:?}");
    // Its usage in the template, the declaration left out, from either file.
    for (doc, pos) in [(ts, title), (html, Pos::new(0, 8))] {
        let refs = mgr.references(doc, pos, false, false, Default::default()).await.unwrap();
        let found: Vec<(std::path::PathBuf, u32)> =
            refs.locations.iter().map(|l| (l.path.to_path_buf(), l.range.start.line)).collect();
        assert_eq!(found, [(app_html.clone(), 0)]);
    }
    tokio::time::timeout(Duration::from_secs(10), mgr.shutdown_all()).await.unwrap();
}
