//! M3 consistency gate (docs/vue-ts-semantic-index.md §10): on the vue-app
//! fixture, the project index's goto must agree with the language server's
//! on workspace navigation. ≥90% agreement is what allows flipping the
//! fallback order (index first, LSP refining); below that, the index stays
//! a dumb-mode-only floor.
//!
//! `#[ignore]`d like the language smokes: needs vtsls installed
//! (`npm i -g @vtsls/language-server`). Run:
//! `cargo test -p ide-host --test index_consistency -- --ignored --nocapture`

use ide_core::{DocId, NullSink, Pos};
use ide_host::ops::nav::IndexGoto;
use ide_host::{Host, HostConfig, ops};
use ide_lsp::types::GotoKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const WINDOW: &str = "main";
const TIMEOUT: Duration = Duration::from_secs(60);

fn host(base: &Path) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }))
}

/// The position of `needle`'s `nth` (0-based) occurrence, in UTF-16 columns.
fn pos_of(text: &str, needle: &str, nth: usize) -> Pos {
    let mut seen = 0;
    for (line, l) in text.lines().enumerate() {
        let mut from = 0;
        while let Some(i) = l[from..].find(needle) {
            if seen == nth {
                let col = l[..from + i].encode_utf16().count() as u32;
                return Pos::new(line as u32, col);
            }
            seen += 1;
            from += i + needle.len();
        }
    }
    panic!("{needle} #{nth} not found");
}

struct Sample {
    /// The fixture-relative file the caret is in.
    file: &'static str,
    needle: &'static str,
    nth: usize,
    /// The word the index resolves (the caret's identifier).
    word: &'static str,
}

/// Workspace navigation samples: imports (relative, alias, re-export),
/// script-setup state and component tags. Bare package specifiers (`vue`)
/// are excluded — node_modules is the language servers' territory by design.
const SAMPLES: &[Sample] = &[
    Sample { file: "src/App.vue", needle: "useAuth()", nth: 0, word: "useAuth" },
    Sample { file: "src/App.vue", needle: "get('/x')", nth: 0, word: "get" },
    Sample { file: "src/App.vue", needle: "UserCard :user", nth: 0, word: "UserCard" },
    Sample { file: "src/main.ts", needle: "App)", nth: 0, word: "App" },
    Sample { file: "src/main.ts", needle: "createApp(App)", nth: 0, word: "createApp" },
    Sample { file: "src/components/UserCard.vue", needle: "fallback", nth: 0, word: "fallback" },
];

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs vtsls on PATH (npm i -g @vtsls/language-server)"]
async fn index_goto_agrees_with_the_language_server() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.keep()).unwrap();
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/vue-app");
    copy_dir(&fixture, &root);
    let host = host(&root.join("app"));
    host.trust.decide(&root, true, false).unwrap();
    host.open_project(WINDOW, &root).unwrap();
    let project = host.project(WINDOW).unwrap();
    assert!(project.index.wait_idle(TIMEOUT), "indexing finishes");

    // Open every sampled file once so the servers see them (didOpen), then
    // wait for the TypeScript server to answer definitions at all.
    let mut docs: Vec<(DocId, String)> = Vec::new();
    for file in ["src/App.vue", "src/main.ts", "src/components/UserCard.vue"] {
        let info = ops::doc::open(&host, WINDOW, root.join(file)).await.unwrap();
        let info = ops::doc::snapshot(&host, WINDOW, info.id).await.unwrap();
        docs.push((info.id, info.text));
    }
    let (app_doc, app_text) = docs[0].clone();
    retry_until(&host, "vtsls answers a definition", || async {
        match ops::lsp::lsp_goto(&host, WINDOW, app_doc, pos_of(&app_text, "./api'", 0), GotoKind::Definition).await {
            Ok(r) if !r.is_empty() => Ok(()),
            Ok(_) => Err("no definition yet".to_string()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await;

    // Compare: the LSP's definition vs the index's, on path + start line.
    let mut agree = 0;
    let mut total = 0;
    let mut misses: Vec<String> = Vec::new();
    for s in SAMPLES {
        let file = root.join(s.file);
        let text = std::fs::read_to_string(&file).unwrap();
        let doc = docs.iter().find(|(_, t)| *t == text).map(|(d, _)| *d);
        let Some(doc) = doc else { continue };
        let pos = pos_of(&text, s.needle, s.nth);

        let lsp = ops::lsp::lsp_goto(&host, WINDOW, doc, pos, GotoKind::Definition).await.unwrap_or_default();
        let index: Option<IndexGoto> =
            ops::nav::index_goto(&host, WINDOW, doc, pos, s.word.to_string()).await.unwrap_or_default();
        let lsp_key = lsp.first().map(key);
        let index_key = index.and_then(|g| g.targets.first().map(key));
        total += 1;
        if lsp_key.is_some() && lsp_key == index_key {
            agree += 1;
        } else {
            misses.push(format!("{}:{}: lsp {lsp_key:?} vs index {index_key:?}", s.file, s.needle));
        }
    }
    let rate = agree as f64 / total.max(1) as f64;
    println!("\nagreement: {agree}/{total} = {:.0}%", rate * 100.0);
    for m in &misses {
        println!("  disagree: {m}");
    }
    assert!(
        rate >= 0.9,
        "index/goto agreement {agree}/{total} is below the 90% gate; the fallback order must not flip"
    );
}

fn key(l: &ide_core::Location) -> String {
    format!("{}:{}", PathBuf::from(l.path.clone()).display(), l.range.start.line)
}

fn copy_dir(from: &Path, to: &Path) {
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            std::fs::create_dir_all(&target).unwrap();
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// Retries `f` until it returns Ok (servers answer emptily while starting);
/// on timeout, panics with the last error.
async fn retry_until(host: &Host, what: &str, mut f: impl AsyncFnMut() -> Result<(), String>) {
    let deadline = std::time::Instant::now() + TIMEOUT;
    loop {
        if f().await.is_ok() {
            return;
        }
        if std::time::Instant::now() > deadline {
            let servers = ops::lsp::lsp_servers(host, WINDOW).unwrap_or_default();
            let names: Vec<String> = servers.iter().map(|s| format!("{} ({:?})", s.name, s.status)).collect();
            panic!("{what}: timed out; servers: {names:?}");
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}
