//! `cargo bench -p ide-host`: the plugin runtime budgets, checked by `pnpm perf:rust` against
//! `perf/budgets.json` › rust (`plugins/…`).
//!
//! - `load_50`: start-up load of 50 installed plugins (20 with code, 10
//!   languages with a syntax provider, 10 icon themes, 10 declarations only),
//!   from the contribution index; no Wasm is instantiated.
//! - `cold_activation`: an idle-reclaimed plugin's next command: activation
//!   from the precompiled component plus the call.
//! - `syntax_highlights_2k_lines`: an edit-path call (Solidity highlighting).

use criterion::{Criterion, black_box, criterion_group, criterion_main};
use ide_core::LanguageId;
use ide_host::plugins::{Consent, PluginHost};
use ide_plugin::{Invocation, Limits};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let name = e.file_name();
        if matches!(name.to_str(), Some("target" | "src" | "Cargo.lock" | ".gitignore")) {
            continue;
        }
        let dst = to.join(&name);
        if e.path().is_dir() { copy_dir(&e.path(), &dst) } else { std::fs::copy(e.path(), &dst).map(|_| ()).unwrap() }
    }
}

/// A copy of `src` installed under a new id (and new language / theme ids).
fn variant(work: &Path, src: &Path, n: usize, rename: &[(&str, String)]) -> PathBuf {
    let dir = work.join(format!("pkg{n}"));
    copy_dir(src, &dir);
    for file in ["plugin.toml", "languages/solidity.toml"] {
        let path = dir.join(file);
        if let Ok(mut text) = std::fs::read_to_string(&path) {
            for (from, to) in rename {
                text = text.replace(from, to);
            }
            std::fs::write(&path, text).unwrap();
        }
    }
    dir
}

fn sink() -> Arc<dyn ide_host::plugins::PluginEventSink> {
    Arc::new(|_: Option<&str>, _| {})
}

fn install_50(plugins: &Path, work: &Path) {
    let host = PluginHost::new(plugins.to_path_buf(), sink(), Limits::default()).unwrap();
    host.load_all();
    let root = repo();
    let mut n = 0;
    let mut install = |src: PathBuf, rename: Vec<(&str, String)>| {
        let pkg = variant(work, &src, n, &rename);
        n += 1;
        host.install_from_dir(&pkg, &Consent::default()).unwrap();
    };
    for i in 0..20 {
        install(
            root.join("crates/ide-plugin/tests/fixtures/hello"),
            vec![("id = \"hello\"", format!("id = \"bench.hello{i}\""))],
        );
    }
    for i in 0..10 {
        install(
            root.join("plugins/official/solidity"),
            vec![
                ("openidea.solidity", format!("bench.solidity{i}")),
                ("id = \"solidity\"", format!("id = \"solidity{i}\"")),
                ("extensions = [\"sol\"]", format!("extensions = [\"sol{i}\"]")),
                ("on-language:solidity", format!("on-language:solidity{i}")),
                ("id = \"forge-", format!("id = \"f{i}-")),
                ("id = \"hardhat-", format!("id = \"h{i}-")),
            ],
        );
    }
    for i in 0..10 {
        install(
            root.join("plugins/official/material-icons"),
            vec![
                ("openidea.material-icons", format!("bench.icons{i}")),
                ("id = \"material\"", format!("id = \"material{i}\"")),
            ],
        );
    }
    for i in 0..10 {
        let dir = work.join(format!("static{i}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("plugin.toml"),
            format!(
                "id = \"bench.static{i}\"\nname = \"Static {i}\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"\n\
                 [[contributes.commands]]\nid = \"a\"\ntitle = \"Static {i}: A\"\nwhen = \"editorLang == rust\"\n"
            ),
        )
        .unwrap();
        host.install_from_dir(&dir, &Consent::default()).unwrap();
    }
}

fn bench(c: &mut Criterion) {
    let tmp = tempfile::tempdir().unwrap();
    let plugins = tmp.path().join("plugins");
    install_50(&plugins, &tmp.path().join("work"));

    let mut g = c.benchmark_group("plugins");
    g.sample_size(20);
    g.bench_function("load_50", |b| {
        b.iter(|| {
            let host = PluginHost::new(plugins.clone(), sink(), Limits::default()).unwrap();
            host.load_all();
            assert_eq!(host.instances(), 0, "start-up instantiates no Wasm");
            black_box(host.list(None).plugins.len())
        })
    });

    let limits = Limits { idle_timeout: Some(Duration::ZERO), ..Limits::default() };
    let host = Arc::new(PluginHost::new(plugins.clone(), sink(), limits).unwrap());
    host.load_all();
    host.warm_component_cache();
    g.bench_function("cold_activation", |b| {
        b.iter(|| {
            host.tick();
            // Fails for want of an editor, after activating and running.
            let r = host.run_command("bench.hello0", "word-count", None, Invocation::default());
            black_box(r.is_err())
        })
    });

    let provider = host.syntax_provider();
    let lang = LanguageId::new("solidity0");
    let unit = "contract Token {\n    uint256 public total;\n    mapping(address => uint256) balances;\n    event Sent(address to, uint256 v);\n    function send(address to, uint256 v) public returns (bool) {\n        // move funds\n        balances[to] += v;\n        emit Sent(to, v);\n        return true;\n    }\n}\n";
    let text = unit.repeat(2000 / unit.lines().count());
    assert!(provider.highlights(&lang, &text).is_some());
    g.bench_function("syntax_highlights_2k_lines", |b| {
        b.iter(|| black_box(provider.highlights(&lang, &text).map(|t| t.len())))
    });
    g.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
