use super::*;
use ide_core::{IdeEvent, NullSink};
use std::sync::atomic::Ordering;

const WAIT: Duration = Duration::from_secs(30);

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    cache: PathBuf,
}

impl Fixture {
    fn new(files: &[(&str, &str)]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let root = dunce::canonicalize(root).unwrap();
        let cache = dir.path().join("cache");
        let f = Self { _dir: dir, root, cache };
        for (rel, text) in files {
            f.write(rel, text);
        }
        f
    }

    fn write(&self, rel: &str, text: &str) -> PathBuf {
        let p = self.root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, text).unwrap();
        p
    }

    fn open_with(&self, sink: SharedSink) -> Arc<ProjectIndex> {
        let languages = Arc::new(LanguageRegistry::load(None).unwrap());
        let syntax = Arc::new(Syntax::new());
        let idx = ProjectIndex::open(
            &self.root,
            &self.cache,
            Vec::new(),
            vec!["**/node_modules".into(), "**/target".into()],
            languages,
            syntax,
            sink,
        )
        .unwrap();
        assert!(idx.wait_idle(WAIT), "indexing did not finish");
        idx
    }

    fn open(&self) -> Arc<ProjectIndex> {
        self.open_with(Arc::new(NullSink))
    }
}

fn files(idx: &ProjectIndex, q: &str) -> Vec<String> {
    idx.find_files(q, 20).into_iter().map(|m| m.rel_path).collect()
}

fn symbols(idx: &ProjectIndex, q: &str, filter: SymbolFilter) -> Vec<String> {
    idx.find_symbols(q, filter, 20).into_iter().map(|m| m.name).collect()
}

fn sample() -> Fixture {
    Fixture::new(&[
        ("src/main.rs", "fn main() {}\nstruct Config { port: u16 }\nimpl Config { fn load() -> Self { todo!() } }\n"),
        ("src/order/OrderController.java", "class OrderController {\n  void save() {}\n  void cancel() {}\n}\n"),
        ("src/order/Order.java", "class Order { int id; }\n"),
        ("src/other/OtherCollection.ts", "export class OtherCollection {\n  add(x: number) {}\n}\n"),
        ("src/ui/Button.tsx", "export function Button() { return <button/>; }\n"),
        ("web/app.py", "class App:\n    def run(self):\n        pass\n\ndef main():\n    pass\n"),
        ("docs/maintenance.md", "# Maintenance\n"),
        ("node_modules/lib/index.js", "function hidden() {}\n"),
        ("target/debug/gen.rs", "fn generated() {}\n"),
        ("data.json", "{\"a\": 1}\n"),
    ])
}

#[test]
fn indexes_files_and_symbols_honouring_excludes() {
    let fx = sample();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink: SharedSink = {
        let events = events.clone();
        Arc::new(move |e: IdeEvent| events.lock().push(e))
    };
    let idx = fx.open_with(sink);
    let st = idx.status();
    assert!(!st.indexing);
    assert_eq!(st.files, 8, "node_modules and target are excluded");
    assert!(st.symbols >= 12, "{st:?}");
    assert!(files(&idx, "index.js").is_empty());
    assert!(symbols(&idx, "generated", SymbolFilter::All).is_empty());

    let states: Vec<bool> = events
        .lock()
        .iter()
        .filter_map(|e| match e {
            IdeEvent::IndexState { indexing, .. } => Some(*indexing),
            _ => None,
        })
        .collect();
    assert_eq!(states.first(), Some(&true));
    assert_eq!(states.last(), Some(&false));
    assert!(events.lock().iter().any(|e| matches!(e, IdeEvent::Task { done: true, .. })));

    let m = &idx.find_symbols("load", SymbolFilter::All, 5)[0];
    assert_eq!((m.name.as_str(), m.container.as_deref(), m.kind), ("load", Some("Config"), SymbolKind::Method));
    assert_eq!(m.rel_path, "src/main.rs");
    assert_eq!(m.range.start.line, 2);
    assert_eq!(m.path, fx.root.join("src/main.rs"));
}

#[test]
fn file_ranking_is_idea_like() {
    let fx = sample();
    let idx = fx.open();
    // File-name matches beat directory matches.
    assert_eq!(files(&idx, "main")[..2], ["src/main.rs".to_owned(), "docs/maintenance.md".to_owned()]);
    assert_eq!(files(&idx, "order")[0], "src/order/Order.java");
    // Path segments.
    assert_eq!(files(&idx, "ui/btn")[0], "src/ui/Button.tsx");
    assert_eq!(files(&idx, "src/order/")[..2].len(), 2);
    assert!(files(&idx, "web/main").is_empty());
    // CamelHump.
    let oco = files(&idx, "OCo");
    assert!(oco[..2].contains(&"src/order/OrderController.java".to_owned()), "{oco:?}");
    assert!(oco[..2].contains(&"src/other/OtherCollection.ts".to_owned()), "{oco:?}");
    assert_eq!(files(&idx, "OrCo")[0], "src/order/OrderController.java");
    assert_eq!(files(&idx, "ordcon")[0], "src/order/OrderController.java");
    // `file:line` suffixes are ignored.
    assert_eq!(files(&idx, "Button.tsx:12")[0], "src/ui/Button.tsx");

    let m = &idx.find_files("main", 1)[0];
    assert_eq!(m.indices, vec![4, 5, 6, 7]);
    let m = &idx.find_files("ui/btn", 1)[0];
    let shown: String = m.indices.iter().map(|&i| m.rel_path.chars().nth(i as usize).unwrap()).collect();
    assert_eq!(shown.to_lowercase(), "uibtn");
}

#[test]
fn shorter_paths_win_ties_and_recent_files_boost() {
    let fx = Fixture::new(&[("a/b/c/util.rs", ""), ("x/util.rs", ""), ("y/util.rs", "")]);
    let idx = fx.open();
    assert_eq!(files(&idx, "util"), vec!["x/util.rs", "y/util.rs", "a/b/c/util.rs"]);
    idx.mark_recent(&fx.root.join("a/b/c/util.rs"));
    assert_eq!(files(&idx, "util")[0], "a/b/c/util.rs");
    // Empty query lists recent files.
    assert_eq!(files(&idx, ""), vec!["a/b/c/util.rs"]);
}

#[test]
fn symbol_ranking_is_idea_like() {
    let fx = sample();
    let idx = fx.open();
    assert_eq!(symbols(&idx, "OrCo", SymbolFilter::Types)[0], "OrderController");
    assert_eq!(symbols(&idx, "OtCo", SymbolFilter::Types)[0], "OtherCollection");
    assert_eq!(symbols(&idx, "ordcon", SymbolFilter::All)[0], "OrderController");
    assert_eq!(
        symbols(&idx, "OC", SymbolFilter::Types)[..2],
        ["OrderController".to_owned(), "OtherCollection".to_owned()]
    );
    // Exact beats prefix.
    assert_eq!(symbols(&idx, "order", SymbolFilter::Types)[0], "Order");
    // Types filter.
    let types = symbols(&idx, "a", SymbolFilter::Types);
    assert!(types.contains(&"App".to_owned()));
    assert!(!types.contains(&"add".to_owned()));
    // Container-qualified queries.
    let m = idx.find_symbols("OrderController.save", SymbolFilter::All, 5);
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].container.as_deref(), Some("OrderController"));
    let m = idx.find_symbols("App.run", SymbolFilter::All, 5);
    assert_eq!(m[0].name, "run");
    // Indices into the name.
    let m = &idx.find_symbols("OCo", SymbolFilter::Types, 1)[0];
    assert_eq!(m.indices, vec![0, 5, 6]);
    assert!(idx.find_symbols("", SymbolFilter::All, 5).is_empty());
}

#[test]
fn recent_files_skip_deleted_files_but_keep_virtual_documents() {
    let fx = sample();
    let idx = fx.open();
    let app = fx.root.join("web/app.py");
    let virt = PathBuf::from("jdt://contents/rt.jar/java.lang/String.class");
    idx.mark_recent(&app);
    idx.mark_recent(&virt);
    assert_eq!(idx.recent_files(), vec![virt.clone(), app.clone()]);
    std::fs::remove_file(&app).unwrap();
    assert_eq!(idx.recent_files(), vec![virt]);
}

#[test]
fn persistence_skips_unchanged_files_on_reopen() {
    let fx = sample();
    {
        let idx = fx.open();
        assert_eq!(idx.shared.parsed.load(Ordering::SeqCst), 8);
        idx.mark_recent(&fx.root.join("web/app.py"));
        assert!(idx.wait_idle(WAIT));
    }
    {
        let idx = fx.open();
        assert_eq!(idx.shared.parsed.load(Ordering::SeqCst), 0, "nothing changed");
        assert_eq!(idx.status().files, 8);
        assert_eq!(symbols(&idx, "OrderController", SymbolFilter::Types)[0], "OrderController");
        assert_eq!(idx.recent_files(), vec![fx.root.join("web/app.py")]);
        idx.remove_recent(&fx.root.join("web/app.py"));
        assert!(idx.recent_files().is_empty());
        assert!(idx.wait_idle(WAIT));
    }
    assert!(fx.open().recent_files().is_empty(), "removal is persisted");
    std::thread::sleep(Duration::from_millis(20));
    fx.write("src/main.rs", "fn main() {}\nfn renamed_fn() {}\n");
    std::fs::remove_file(fx.root.join("docs/maintenance.md")).unwrap();
    {
        let idx = fx.open();
        assert_eq!(idx.shared.parsed.load(Ordering::SeqCst), 1, "only the changed file is re-parsed");
        assert_eq!(idx.status().files, 7);
        assert_eq!(symbols(&idx, "renamed_fn", SymbolFilter::All), vec!["renamed_fn"]);
        assert!(symbols(&idx, "Config", SymbolFilter::Types).is_empty());
    }
}

#[test]
fn incremental_updates() {
    let fx = sample();
    let idx = fx.open();
    let before = idx.status();

    // New file.
    let p = fx.write("src/new/Fresh.kt", "class FreshThing {\n  fun go() {}\n}\n");
    idx.update(std::slice::from_ref(&p), &[]);
    assert!(idx.wait_idle(WAIT));
    assert_eq!(symbols(&idx, "FreshThing", SymbolFilter::Types), vec!["FreshThing"]);
    assert_eq!(idx.status().files, before.files + 1);

    // Modified file.
    std::thread::sleep(Duration::from_millis(20));
    fx.write("src/new/Fresh.kt", "class Renamed {\n}\n");
    idx.update(std::slice::from_ref(&p), &[]);
    assert!(idx.wait_idle(WAIT));
    assert!(symbols(&idx, "FreshThing", SymbolFilter::Types).is_empty());
    assert_eq!(symbols(&idx, "Renamed", SymbolFilter::Types), vec!["Renamed"]);

    // Removed file and removed directory.
    std::fs::remove_file(&p).unwrap();
    std::fs::remove_dir_all(fx.root.join("src/order")).unwrap();
    idx.update(&[], &[p, fx.root.join("src/order")]);
    assert!(idx.wait_idle(WAIT));
    assert!(files(&idx, "Fresh").is_empty());
    assert!(symbols(&idx, "OrderController", SymbolFilter::All).is_empty());
    assert_eq!(idx.status().files, before.files - 2);

    // New directory (reported as a directory), excluded and outside paths are ignored.
    fx.write("lib/a/one.go", "package a\nfunc One() {}\n");
    fx.write("lib/a/two.go", "package a\nfunc Two() {}\n");
    let ignored = fx.write("node_modules/x/y.js", "function nope() {}\n");
    idx.update(&[fx.root.join("lib"), ignored, PathBuf::from("/definitely/not/here.rs")], &[]);
    assert!(idx.wait_idle(WAIT));
    assert_eq!(symbols(&idx, "One", SymbolFilter::All), vec!["One"]);
    assert_eq!(symbols(&idx, "Two", SymbolFilter::All), vec!["Two"]);
    assert!(symbols(&idx, "nope", SymbolFilter::All).is_empty());
}

#[test]
fn binary_and_huge_files_are_listed_without_symbols() {
    let fx = Fixture::new(&[("img/logo.rs", "")]);
    std::fs::write(fx.root.join("img/logo.rs"), b"fn a() {}\0\x01\x02").unwrap();
    let huge = "fn x() {}\n".repeat((MAX_SYMBOL_FILE as usize / 10) + 10);
    fx.write("big/huge.rs", &huge);
    let idx = fx.open();
    assert_eq!(files(&idx, "logo"), vec!["img/logo.rs"]);
    assert_eq!(files(&idx, "huge"), vec!["big/huge.rs"]);
    assert_eq!(idx.status().symbols, 0);
}

#[test]
fn second_window_on_same_project_works_in_memory() {
    let fx = sample();
    let a = fx.open();
    let b = fx.open();
    assert_eq!(a.status().files, b.status().files);
    assert_eq!(symbols(&b, "Order", SymbolFilter::Types)[0], "Order");
}

/// Synthetic 100k-file project. Run with:
/// `cargo test --release -p ide-index bench_large_project -- --ignored --nocapture`
#[test]
#[ignore]
fn bench_large_project() {
    use std::time::Instant;
    let n: usize = std::env::var("OPENIDEA_BENCH_FILES").ok().and_then(|v| v.parse().ok()).unwrap_or(100_000);
    let fx = Fixture::new(&[]);
    let t = Instant::now();
    let words = ["order", "user", "invoice", "payment", "cart", "session", "report", "config", "event", "queue"];
    for i in 0..n {
        let w = words[i % words.len()];
        let w2 = words[(i / 10) % words.len()];
        let cap = |s: &str| format!("{}{}", s[..1].to_uppercase(), &s[1..]);
        let dir = format!("mod{}/{}/{}", i % 50, w2, i % 7);
        let (rel, text) = match i % 4 {
            0 => (
                format!("{dir}/{w}_{i}.rs"),
                format!(
                    "pub struct {C}{i} {{ id: u64 }}\nimpl {C}{i} {{\n    pub fn new() -> Self {{ Self {{ id: {i} }} }}\n    pub fn process_{w}(&self) {{}}\n}}\n",
                    C = cap(w)
                ),
            ),
            1 => (
                format!("{dir}/{C}{D}Service{i}.ts", C = cap(w), D = cap(w2)),
                format!(
                    "export class {C}{D}Service{i} {{\n  handle{C}(x: number) {{ return x; }}\n}}\n",
                    C = cap(w),
                    D = cap(w2)
                ),
            ),
            2 => (
                format!("{dir}/{w}_{i}.py"),
                format!("class {C}Model{i}:\n    def save(self):\n        pass\n", C = cap(w)),
            ),
            _ => (
                format!("{dir}/{C}Controller{i}.java", C = cap(w)),
                format!("class {C}Controller{i} {{\n  void get() {{}}\n}}\n", C = cap(w)),
            ),
        };
        fx.write(&rel, &text);
    }
    eprintln!("generated {n} files in {:?}", t.elapsed());

    let t = Instant::now();
    let idx = fx.open();
    let first = t.elapsed();
    let st = idx.status();
    eprintln!("first index: {first:?} ({} files, {} symbols)", st.files, st.symbols);
    assert_eq!(st.files as usize, n);
    drop(idx);

    let t = Instant::now();
    let idx = fx.open();
    eprintln!("re-open (cache hit): {:?}, parsed {}", t.elapsed(), idx.shared.parsed.load(Ordering::SeqCst));

    let mut times = Vec::new();
    for q in ["order", "OCo", "usrsvc", "mod3/cart", "payment_1234", "Contr", "x", "InvoiceUserService", "zzzz"] {
        for _ in 0..5 {
            let t = Instant::now();
            let r = idx.find_files(q, 50);
            times.push(t.elapsed());
            std::hint::black_box(r);
        }
    }
    let mut stimes = Vec::new();
    for q in ["OCo", "process_order", "handleCart", "save", "UserModel1", "Order.new", "q", "zzzz"] {
        for _ in 0..5 {
            let t = Instant::now();
            let r = idx.find_symbols(q, SymbolFilter::All, 50);
            stimes.push(t.elapsed());
            std::hint::black_box(r);
        }
    }
    times.sort();
    stimes.sort();
    eprintln!(
        "find_files p50 {:?} p90 {:?} max {:?}",
        times[times.len() / 2],
        times[times.len() * 9 / 10],
        times.last().unwrap()
    );
    eprintln!(
        "find_symbols p50 {:?} p90 {:?} max {:?}",
        stimes[stimes.len() / 2],
        stimes[stimes.len() * 9 / 10],
        stimes.last().unwrap()
    );
    if n >= 100_000 {
        assert!(first < Duration::from_secs(30), "first index took {first:?}");
    }
}

#[test]
fn compact_keeps_results() {
    let f = Fixture::new(&[("src/order.rs", "struct Order;\nfn place_order() {}\n"), ("b.rs", "fn b() {}\n")]);
    let idx = f.open();
    let before = (files(&idx, "order"), symbols(&idx, "Order", SymbolFilter::All));
    std::fs::remove_file(f.root.join("b.rs")).unwrap();
    idx.update(&[], &[f.root.join("b.rs")]);
    assert!(idx.wait_idle(WAIT));
    idx.compact();
    assert_eq!((files(&idx, "order"), symbols(&idx, "Order", SymbolFilter::All)), before);
    assert_eq!(idx.status().files, 1);
}

#[test]
fn synthetic_index_answers_queries() {
    let s = bench_support::SyntheticIndex::new(3_000, 4);
    assert_eq!((s.file_count(), s.symbol_count()), (3_000, 12_000));
    assert!(!s.find_files("ordcon", 20).is_empty());
    assert!(!s.find_symbols("PaySe", SymbolFilter::All, 20).is_empty());
    assert!(s.find_symbols("PaySe", SymbolFilter::Types, 20).iter().all(|m| m.kind == SymbolKind::Class));
}

#[test]
fn css_selectors_are_found_by_exact_name() {
    let f = Fixture::new(&[
        ("web/a.css", ".card { --gap: 1px }\n.cardigan {}\n"),
        ("web/b.scss", ".list { .card { } }\n"),
        ("web/index.html", "<style>.card{}</style>\n<div class=\"card\"></div>\n"),
    ]);
    let idx = f.open();
    let found: Vec<(String, u32)> = idx
        .symbols_named(".card", Some(SymbolKind::Class), 10)
        .into_iter()
        .map(|m| (m.rel_path, m.range.start.line))
        .collect();
    assert_eq!(found, vec![("web/a.css".into(), 0), ("web/b.scss".into(), 0), ("web/index.html".into(), 0)]);
    assert_eq!(idx.symbols_named("--gap", None, 10).len(), 1);
    assert!(idx.symbols_named(".card", Some(SymbolKind::Field), 10).is_empty());
}

#[test]
fn content_roots_and_excludes_change_without_reopening() {
    let fx = Fixture::new(&[("src/main.rs", "fn alpha() {}\n"), ("src/gen/out.rs", "fn generated() {}\n")]);
    let shared = fx._dir.path().join("shared-lib");
    std::fs::create_dir_all(shared.join("src")).unwrap();
    std::fs::write(shared.join("src/lib.rs"), "fn gamma() {}\n").unwrap();
    let idx = fx.open();
    assert!(files(&idx, "lib.rs").is_empty());

    let excludes = vec!["**/node_modules".to_owned(), "**/target".to_owned()];
    assert!(idx.set_scope(vec![shared.clone()], excludes.clone()));
    assert!(!idx.set_scope(vec![shared.clone()], excludes.clone()), "unchanged scope");
    assert!(idx.wait_idle(WAIT));
    assert_eq!(files(&idx, "lib.rs"), ["shared-lib/src/lib.rs"]);
    let gamma = &idx.find_symbols("gamma", SymbolFilter::All, 5)[0];
    assert_eq!(gamma.path, dunce::canonicalize(shared.join("src/lib.rs")).unwrap());

    // Files created in a content root are picked up incrementally.
    std::fs::write(shared.join("src/more.rs"), "fn delta() {}\n").unwrap();
    idx.update(&[shared.join("src/more.rs")], &[]);
    assert!(idx.wait_idle(WAIT));
    assert_eq!(symbols(&idx, "delta", SymbolFilter::All), ["delta"]);

    // A new exclude drops what it matches; removing the root drops its files.
    let mut more = excludes.clone();
    more.push("gen".into());
    idx.set_scope(Vec::new(), more);
    assert!(idx.wait_idle(WAIT));
    assert!(files(&idx, "out.rs").is_empty());
    assert!(files(&idx, "lib.rs").is_empty());
    assert_eq!(idx.status().files, 1);
    drop(idx);

    // Extra roots are not persisted: reopening without them lists only the project.
    let idx = fx.open();
    assert!(symbols(&idx, "gamma", SymbolFilter::All).is_empty());
}

#[test]
fn file_type_changes_reparse_affected_files() {
    let fx = Fixture::new(&[("src/main.rs", "fn alpha() {}\n"), ("src/legacy.inc", "fn beta() {}\n")]);
    let languages = Arc::new(LanguageRegistry::load(None).unwrap());
    let idx = ProjectIndex::open(
        &fx.root,
        &fx.cache,
        Vec::new(),
        Vec::new(),
        languages.clone(),
        Arc::new(Syntax::new()),
        Arc::new(NullSink),
    )
    .unwrap();
    assert!(idx.wait_idle(WAIT));
    assert!(symbols(&idx, "beta", SymbolFilter::All).is_empty(), "plain text has no symbols");
    let parsed = idx.shared.parsed.load(Ordering::SeqCst);

    let before = Arc::new(languages.snapshot());
    let mut ft = ide_language::FileTypes::default();
    ft.associations.insert(
        "rust".into(),
        ide_core::settings::FileTypeAssociation { patterns: vec!["*.inc".into()], ..Default::default() },
    );
    assert!(languages.set_file_types(ft));
    idx.languages_changed(before);
    assert!(idx.wait_idle(WAIT));
    assert_eq!(symbols(&idx, "beta", SymbolFilter::All), ["beta"]);
    assert_eq!(idx.shared.parsed.load(Ordering::SeqCst), parsed + 1, "only the affected file is re-parsed");
}

#[test]
fn unindexed_index_never_scans_or_persists() {
    let fx = Fixture::new(&[("a.rs", "fn alpha() {}\n")]);
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink: SharedSink = {
        let events = events.clone();
        Arc::new(move |e: IdeEvent| events.lock().push(e))
    };
    let languages = Arc::new(LanguageRegistry::load(None).unwrap());
    let idx = ProjectIndex::unindexed(&fx.root, languages, Arc::new(Syntax::new()), sink).unwrap();
    assert!(idx.wait_idle(WAIT));
    let st = idx.status();
    assert!(!st.indexing);
    assert_eq!(st.files, 0);
    assert!(files(&idx, "a").is_empty());
    idx.mark_recent(&fx.root.join("a.rs"));
    assert!(idx.wait_idle(WAIT));
    assert_eq!(idx.recent_files(), vec![fx.root.join("a.rs")]);
    assert!(!fx.cache.exists());
    assert!(!events.lock().iter().any(|e| matches!(e, IdeEvent::Task { .. })), "no indexing task");
}
