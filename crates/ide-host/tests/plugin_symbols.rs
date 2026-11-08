//! The synchronous workspace import uses the real project index, also from a provider.
use ide_core::CancellationToken;
use ide_core::{NullSink, Pos, Range};
use ide_host::plugins::{Consent, HostWorkspace, PluginHost, PluginWorkspace};
use ide_host::{Host, HostConfig};
use ide_plugin::{Invocation, Limits, ProviderDocument};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(30);

struct Fixture {
    _tmp: tempfile::TempDir,
    _runtime: tokio::runtime::Runtime,
    host: Arc<Host>,
    plugins: PluginHost,
    root: PathBuf,
    other: PathBuf,
}

impl Fixture {
    fn new(capability: bool) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let (root, other) = (base.join("project"), base.join("other"));
        for dir in [&root, &other] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(root.join("Order.php"), "<?php class OrderController { public function item() {} }\n").unwrap();
        std::fs::write(root.join("Main.java"), "class OrderService { void serve() {} }\n").unwrap();
        std::fs::write(other.join("Order.php"), "<?php class OrderElsewhere {}\n").unwrap();
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let syntax = OnceLock::new();
        syntax.set(Arc::new(ide_language::Syntax::new())).ok().unwrap();
        let host = Arc::new(Host::new(HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::new(syntax),
            sink_for: Box::new(|_| Arc::new(NullSink)),
            owner: |w| w,
            runtime: runtime.handle().clone(),
            project_environment: false,
        }));
        // Restricted projects need no LSP/process startup for index queries.
        {
            let _guard = runtime.enter();
            for (window, dir) in [("main", &root), ("other", &other)] {
                let project = host.open_project(window, dir).unwrap();
                assert!(project.index.wait_idle(WAIT));
            }
        }
        let plugins = PluginHost::new(
            base.join("plugins"),
            Arc::new(|_: Option<&str>, _| {}),
            Limits { edit_soft: Duration::from_secs(5), edit_hard: Duration::from_secs(10), ..Limits::default() },
        )
        .unwrap();
        plugins.set_workspace(Some(Arc::new(HostWorkspace(Arc::downgrade(&host)))));
        plugins.set_project_policy(Arc::new(|_| true));
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/symbols");
        let package = base.join("fixture");
        std::fs::create_dir_all(package.join("dist")).unwrap();
        std::fs::copy(source.join("dist/plugin.wasm"), package.join("dist/plugin.wasm")).unwrap();
        let manifest = std::fs::read_to_string(source.join("plugin.toml")).unwrap();
        let manifest =
            if capability { manifest } else { manifest.replace("required = [\"project.read\"]", "required = []") };
        std::fs::write(package.join("plugin.toml"), manifest).unwrap();
        plugins.install_from_dir(&package, &Consent::all()).unwrap();
        Self { _tmp: tmp, _runtime: runtime, host, plugins, root, other }
    }

    fn invoke(&self, command: &str, root: &Path, query: &str) -> ide_core::IdeResult<Option<String>> {
        self.plugins.run_command(
            "test.symbols",
            command,
            Some(query),
            Invocation { workspace_root: Some(root.to_path_buf()), ..Default::default() },
        )
    }

    fn search(&self, query: &str) -> String {
        self.invoke("symbols", &self.root, query).unwrap().unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.host.close_project("main");
        self.host.close_project("other");
    }
}

#[test]
fn symbols_reach_commands_and_providers_without_a_language_server() {
    let f = Fixture::new(true);
    let all = f.search("Order|10");
    assert!(all.contains("OrderController\tclass\t"), "{all}");
    assert!(all.contains("OrderService\tclass\t"), "{all}");
    assert!(!all.contains("OrderElsewhere"));
    assert_eq!(f.search("OCo|1").lines().count(), 1);
    assert!(f.search("OrderController.item|1").starts_with("item\tmethod\tOrderController\t"));
    assert!(f.search("|10").is_empty());
    assert!(f.search("Order|0").is_empty());
    assert!(f.search("missing|10").is_empty());
    assert!(f.search("Order|4294967295").contains("OrderController"));
    assert!(
        f.invoke("symbols", &f.root, &format!("{}|1", "é".repeat(129)))
            .unwrap_err()
            .message
            .contains("256 UTF-8 bytes")
    );
    let other = f.invoke("symbols", &f.other, "Order|10").unwrap().unwrap();
    assert!(other.contains("OrderElsewhere") && !other.contains("OrderController"));
    for language in ["php", "java"] {
        let targets = f.plugins.provide_definition(
            &ProviderDocument {
                path: f.root.join(if language == "php" { "Usage.php" } else { "Usage.java" }),
                language: language.into(),
                version: 1,
                text: "OCo".into(),
            },
            Pos::new(0, 3),
        );
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].path, f.root.join("Order.php"));
        let indexed = HostWorkspace(Arc::downgrade(&f.host))
            .symbols(&f.root, "OCo", 1, &CancellationToken::new(), Instant::now() + WAIT)
            .unwrap();
        assert_eq!(targets[0].range, indexed[0].location.range);
    }
}

#[test]
fn reindex_and_closed_project_replace_results_and_invalidate_retained_handles() {
    let f = Fixture::new(true);
    f.invoke("remember", &f.root, "").unwrap();
    let p = f.host.project("main").unwrap();
    let path = f.root.join("Order.php");
    std::fs::write(&path, "<?php /*😀*/ class UpdatedController {}\n").unwrap();
    p.index.update(std::slice::from_ref(&path), &[]);
    assert!(p.index.wait_idle(WAIT));
    assert!(!f.search("Order|10").contains("OrderController"));
    let symbols = HostWorkspace(Arc::downgrade(&f.host))
        .symbols(&f.root, "UpdatedController", 1, &CancellationToken::new(), Instant::now() + WAIT)
        .unwrap();
    assert_eq!(symbols.len(), 1);
    assert_eq!(symbols[0].location.range, Range::new(Pos::new(0, 19), Pos::new(0, 36)));
    assert!(f.search("Updated|10").contains("0:19-0:36"));
    std::fs::remove_file(&path).unwrap();
    p.index.update(&[], &[path]);
    assert!(p.index.wait_idle(WAIT));
    assert!(f.search("Updated|10").is_empty());
    f.host.close_project("main");
    let error = f.invoke("remembered", &f.root, "Order|10").unwrap_err();
    assert!(error.message.contains("no longer open"), "{error}");
}

#[test]
fn large_limits_are_capped_before_searching_the_index() {
    let f = Fixture::new(true);
    let project = f.host.project("main").unwrap();
    let path = f.root.join("Bulk.java");
    let text = (0..1005).map(|i| format!("class BulkSymbol{i} {{}}\n")).collect::<String>();
    std::fs::write(&path, text).unwrap();
    project.index.update(&[path], &[]);
    assert!(project.index.wait_idle(WAIT));
    assert_eq!(f.search("BulkSymbol|4294967295").lines().count(), 1000);
}

#[test]
fn symbol_queries_require_project_read_even_with_an_invocation_project() {
    let f = Fixture::new(false);
    let error = f.invoke("symbols", &f.root, "Order|10").unwrap_err();
    assert!(error.message.contains("project.read"), "{error}");
    assert!(
        f.plugins
            .provide_definition(
                &ProviderDocument {
                    path: f.root.join("Usage.php"),
                    language: "php".into(),
                    version: 1,
                    text: "OCo".into(),
                },
                Pos::new(0, 3)
            )
            .is_empty()
    );
}

#[test]
fn symbol_search_excludes_external_content_roots_before_ranking() {
    let f = Fixture::new(true);
    let project = f.host.project("main").unwrap();
    std::fs::write(f.other.join("Exact.php"), "<?php class Order {}\n").unwrap();
    project.index.set_scope(vec![f.other.clone()], Vec::new());
    assert!(project.index.wait_idle(WAIT));
    assert_eq!(project.index.find_symbols("OrderElsewhere", ide_index::SymbolFilter::All, 1).len(), 1);
    assert!(f.search("OrderElsewhere|10").is_empty());
    // A better external match must not displace a readable fuzzy match.
    let result = f.search("Order|1");
    assert!(result.contains("OrderController") || result.contains("OrderService"), "{result}");
}

#[test]
fn native_symbol_search_honours_cancellation_and_deadlines() {
    let f = Fixture::new(true);
    let workspace = HostWorkspace(Arc::downgrade(&f.host));
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        workspace.symbols(&f.root, "Order", 10, &cancel, Instant::now() + WAIT),
        Err(ide_plugin::HostError::Cancelled)
    );
    let error = workspace.symbols(&f.root, "Order", 10, &CancellationToken::new(), Instant::now()).unwrap_err();
    assert!(error.to_string().contains("timed out"), "{error}");
}

#[cfg(unix)]
#[test]
fn symbol_search_excludes_updates_through_escaping_symlink_ancestors() {
    let f = Fixture::new(true);
    let project = f.host.project("main").unwrap();
    std::fs::write(f.other.join("Secret.php"), "<?php class SecretSymbol {}\n").unwrap();
    let dir = f.root.join("linked");
    std::os::unix::fs::symlink(&f.other, &dir).unwrap();
    project.index.update(&[dir.join("Secret.php")], &[]);
    assert!(project.index.wait_idle(WAIT));
    assert!(f.search("Secret|1").is_empty());
}
