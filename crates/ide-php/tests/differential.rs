//! Differential test: the native engine against Intelephense.
//!
//! Over N identifier positions sampled from a PHP project, it asks Intelephense (through
//! `ide-lsp`, the way the app does) and the engine for go to definition and hover, and writes a
//! JSON and a Markdown report of where they agree and differ to `target/php-differential/`.
//! The engine has no query API yet, so its side answers `unanswered` and only the Intelephense
//! side and the report run; wire [`Engine`] up once definition and hover exist.
//!
//! The runs are `#[ignore]`d because they need Intelephense (`npm i -g intelephense`), and
//! `corpus` also the corpora (`scripts/php-corpus.sh`):
//!
//! ```text
//! cargo test -p ide-php --test differential -- --ignored --exact fixture
//! cargo test -p ide-php --test differential -- --ignored --exact corpus
//! ```
//!
//! Environment: `PHP_DIFF_SAMPLES` (positions per project, default 200), `PHP_DIFF_SEED`,
//! `PHP_DIFF_CORPUS` (comma-separated corpus directories, default all three) and
//! `PHP_CORPUS_DIR` (default `../php-corpus` next to the workspace).

use ide_core::event::ServerStatus;
use ide_core::{CancellationToken, DocId, IdeEvent, LanguageId, Location, Pos};
use ide_language::LanguageRegistry;
use ide_lsp::LspManager;
use ide_lsp::types::GotoKind;
use ide_php::mago::database::file::FileId;
use ide_php::mago::syntax::lexer::Lexer;
use ide_php::mago::syntax::settings::LexerSettings;
use ide_php::mago::syntax::token::TokenKind;
use ide_php::mago::syntax_core::input::Input;
use ide_text::Document;
use serde::Serialize;
use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Intelephense skips larger files by default (`intelephense.files.maxSize`).
const MAX_FILE_BYTES: u64 = 1_000_000;
const DEFAULT_SEED: u64 = 0x5eed_0006;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Indexing counts as finished once the server has stayed ready this long.
const QUIET: Duration = Duration::from_secs(3);
/// Differences listed per query in the Markdown report; the JSON has all of them.
const MAX_LISTED: usize = 100;
/// Samples shown in the Markdown table of answers.
const MAX_TABLE: usize = 50;

// ---- sampling ----

/// A name the lexer found: the byte range of its last segment (`Bar` in `\App\Bar`).
#[derive(Clone, Debug, PartialEq, Eq)]
struct Candidate {
    start: usize,
    end: usize,
    kind: &'static str,
}

impl Candidate {
    /// A byte offset inside the name, where an editor caret would ask from.
    fn caret(&self, source: &str) -> usize {
        let mut mid = self.start + (self.end - self.start) / 2;
        while !source.is_char_boundary(mid) {
            mid -= 1;
        }
        mid
    }
}

/// Identifier positions in a PHP file: names, qualified names and variables, but not
/// keywords, comments, strings or `$this`.
fn candidates(source: &str) -> Vec<Candidate> {
    let mut lexer = Lexer::new(Input::new(FileId::zero(), source.as_bytes()), LexerSettings::default());
    let mut out = Vec::new();
    while let Some(Ok(token)) = lexer.advance() {
        let kind = match token.kind {
            TokenKind::Identifier => "name",
            TokenKind::QualifiedIdentifier | TokenKind::FullyQualifiedIdentifier => "qualified name",
            TokenKind::Variable if token.value != b"$this" => "variable",
            _ => continue,
        };
        let start = token.start.offset as usize;
        let end = start + token.value.len();
        let Some(text) = source.get(start..end) else { continue };
        let start = text.rfind('\\').map_or(start, |i| start + i + 1);
        if start < end {
            out.push(Candidate { start, end, kind });
        }
    }
    out
}

/// SplitMix64: small, seedable and the same on every platform.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// A uniform sample of at most `cap` items from a stream (Algorithm R), so a whole corpus can
/// be sampled without holding every candidate.
struct Reservoir<T> {
    cap: usize,
    seen: u64,
    items: Vec<T>,
    rng: Rng,
}

impl<T> Reservoir<T> {
    fn new(cap: usize, seed: u64) -> Self {
        Self { cap, seen: 0, items: Vec::new(), rng: Rng(seed) }
    }

    fn offer(&mut self, item: T) {
        self.seen += 1;
        if self.items.len() < self.cap {
            self.items.push(item);
        } else if self.cap > 0 {
            let j = self.rng.below(self.seen) as usize;
            if j < self.cap {
                self.items[j] = item;
            }
        }
    }
}

/// `.php` files under `root` in a stable order, without dependencies, VCS data and files
/// Intelephense would skip.
fn php_files(root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if !matches!(entry.file_name().to_str(), Some("vendor" | "node_modules" | ".git")) {
                    walk(&path, out);
                }
            } else if path.extension().is_some_and(|e| e == "php")
                && entry.metadata().is_ok_and(|m| m.len() <= MAX_FILE_BYTES)
            {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, &mut out);
    out.sort();
    out
}

/// The text a file is queried with: line endings normalized the way the editor's documents
/// are, so byte offsets and positions agree.
fn read_document(path: &Path) -> Option<Document> {
    std::fs::read_to_string(path).ok().map(|text| Document::new(&text))
}

struct Sampled {
    files: Vec<PathBuf>,
    candidates: u64,
    /// (file index, candidate), in file and offset order.
    picks: Vec<(usize, Candidate)>,
}

fn sample(root: &Path, n: usize, seed: u64) -> Sampled {
    let files = php_files(root);
    let mut reservoir = Reservoir::new(n, seed);
    for (i, path) in files.iter().enumerate() {
        let Some(doc) = read_document(path) else { continue };
        for c in candidates(&doc.text()) {
            reservoir.offer((i, c));
        }
    }
    let mut picks = reservoir.items;
    picks.sort_by_key(|(file, c)| (*file, c.start));
    Sampled { files, candidates: reservoir.seen, picks }
}

// ---- answers and comparison ----

/// One side's answer to one query.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "reply", content = "value", rename_all = "camelCase")]
enum Reply<T> {
    /// The side has no API for this query yet.
    Unanswered,
    Error(String),
    Empty,
    Found(T),
}

/// A definition target. `path` is relative to the project root with `/` separators when it is
/// inside it, otherwise absolute (built-in stubs).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
struct Target {
    path: String,
    line: u32,
    col: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Outcome {
    Agree,
    Differ,
    OnlyIntelephense,
    OnlyEngine,
    BothEmpty,
    EngineUnanswered,
    Error,
}

fn compare<T>(intelephense: &Reply<T>, engine: &Reply<T>, same: impl Fn(&T, &T) -> bool) -> Outcome {
    match (intelephense, engine) {
        (_, Reply::Unanswered) => Outcome::EngineUnanswered,
        (Reply::Error(_), _) | (_, Reply::Error(_)) | (Reply::Unanswered, _) => Outcome::Error,
        (Reply::Empty, Reply::Empty) => Outcome::BothEmpty,
        (Reply::Found(_), Reply::Empty) => Outcome::OnlyIntelephense,
        (Reply::Empty, Reply::Found(_)) => Outcome::OnlyEngine,
        (Reply::Found(a), Reply::Found(b)) => {
            if same(a, b) {
                Outcome::Agree
            } else {
                Outcome::Differ
            }
        }
    }
}

/// Definitions agree when they name the same lines of the same files: servers differ on
/// whether a target is the declaration's name or its first token.
fn same_targets(a: &[Target], b: &[Target]) -> bool {
    let lines = |t: &[Target]| t.iter().map(|t| (t.path.clone(), t.line)).collect::<BTreeSet<_>>();
    lines(a) == lines(b)
}

/// Hover text with whitespace runs collapsed, so line wrapping doesn't count as a difference.
fn normalize_hover(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn relative_path(root: &Path, path: &str) -> String {
    let path = path.replace('\\', "/");
    let root = root.to_string_lossy().replace('\\', "/");
    let root = root.trim_end_matches('/');
    // Drive-letter case differs between URIs and canonical paths on Windows.
    match path.get(..root.len()) {
        Some(prefix) if prefix.eq_ignore_ascii_case(root) && path[root.len()..].starts_with('/') => {
            path[root.len() + 1..].to_owned()
        }
        _ => path,
    }
}

fn targets(root: &Path, locations: Vec<Location>) -> Reply<Vec<Target>> {
    let mut out: Vec<Target> = locations
        .into_iter()
        .map(|l| Target {
            path: l.uri.clone().unwrap_or_else(|| relative_path(root, &l.path.to_string_lossy())),
            line: l.range.start.line,
            col: l.range.start.col,
        })
        .collect();
    out.sort();
    out.dedup();
    if out.is_empty() { Reply::Empty } else { Reply::Found(out) }
}

#[derive(Serialize)]
struct Compared<T> {
    outcome: Outcome,
    intelephense: Reply<T>,
    engine: Reply<T>,
}

impl<T> Compared<T> {
    fn new(intelephense: Reply<T>, engine: Reply<T>, same: impl Fn(&T, &T) -> bool) -> Self {
        Self { outcome: compare(&intelephense, &engine, same), intelephense, engine }
    }
}

/// One sampled position. `line` and `col` are 0-based, `col` in UTF-16 code units.
#[derive(Serialize)]
struct Sample {
    file: String,
    line: u32,
    col: u32,
    name: String,
    kind: &'static str,
    definition: Compared<Vec<Target>>,
    hover: Compared<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Tally {
    agree: usize,
    differ: usize,
    only_intelephense: usize,
    only_engine: usize,
    both_empty: usize,
    engine_unanswered: usize,
    error: usize,
    /// Positions where Intelephense found something.
    intelephense_found: usize,
}

impl Tally {
    fn add<T>(&mut self, c: &Compared<T>) {
        match c.outcome {
            Outcome::Agree => self.agree += 1,
            Outcome::Differ => self.differ += 1,
            Outcome::OnlyIntelephense => self.only_intelephense += 1,
            Outcome::OnlyEngine => self.only_engine += 1,
            Outcome::BothEmpty => self.both_empty += 1,
            Outcome::EngineUnanswered => self.engine_unanswered += 1,
            Outcome::Error => self.error += 1,
        }
        if matches!(c.intelephense, Reply::Found(_)) {
            self.intelephense_found += 1;
        }
    }

    /// Agreement over the positions where both sides answered and at least one found
    /// something, as a percentage; `None` when there are none.
    fn agreement(&self) -> Option<f64> {
        let answered = self.agree + self.differ + self.only_intelephense + self.only_engine;
        (answered > 0).then(|| 100.0 * self.agree as f64 / answered as f64)
    }
}

#[derive(Serialize)]
struct Report {
    name: String,
    root: String,
    seed: u64,
    files: usize,
    candidates: u64,
    definition: Tally,
    hover: Tally,
    samples: Vec<Sample>,
}

impl Report {
    fn new(name: &str, root: &Path, seed: u64, files: usize, candidates: u64, samples: Vec<Sample>) -> Self {
        let mut definition = Tally::default();
        let mut hover = Tally::default();
        for s in &samples {
            definition.add(&s.definition);
            hover.add(&s.hover);
        }
        Report {
            name: name.to_owned(),
            root: root.to_string_lossy().replace('\\', "/"),
            seed,
            files,
            candidates,
            definition,
            hover,
            samples,
        }
    }
}

// ---- report rendering ----

fn cell(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with("```")).unwrap_or("");
    let mut out: String = line.chars().take(80).collect();
    if line.chars().count() > 80 {
        out.push('…');
    }
    out.replace('|', "\\|")
}

fn show_targets(reply: &Reply<Vec<Target>>) -> String {
    show(reply, |t| t.iter().map(|t| format!("{}:{}", t.path, t.line + 1)).collect::<Vec<_>>().join(", "))
}

fn show_hover(reply: &Reply<String>) -> String {
    show(reply, |h| cell(h))
}

fn show<T>(reply: &Reply<T>, found: impl Fn(&T) -> String) -> String {
    match reply {
        Reply::Unanswered => "unanswered".into(),
        Reply::Error(e) => format!("error: {}", cell(e)),
        Reply::Empty => "—".into(),
        Reply::Found(v) => found(v),
    }
}

fn markdown(report: &Report) -> String {
    let mut md = String::new();
    let _ = writeln!(md, "# PHP differential report: {}\n", report.name);
    let _ = writeln!(
        md,
        "Root `{}` · seed {} · {} files · {} candidate positions · {} sampled\n",
        report.root,
        report.seed,
        report.files,
        report.candidates,
        report.samples.len()
    );
    md.push_str("| Query | Agree | Differ | Only Intelephense | Only engine | Both empty | Engine unanswered | Errors | Intelephense found | Agreement |\n");
    md.push_str("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n");
    for (query, t) in [("definition", &report.definition), ("hover", &report.hover)] {
        let agreement = t.agreement().map_or("n/a".to_owned(), |p| format!("{p:.1}%"));
        let _ = writeln!(
            md,
            "| {query} | {} | {} | {} | {} | {} | {} | {} | {} | {agreement} |",
            t.agree,
            t.differ,
            t.only_intelephense,
            t.only_engine,
            t.both_empty,
            t.engine_unanswered,
            t.error,
            t.intelephense_found
        );
    }
    md.push_str(
        "\nAgreement counts the positions where both sides answered and at least one found something. \
         Definitions agree when they name the same lines of the same files; hovers agree when their \
         text matches up to whitespace. Positions below are 1-based `file:line:col`.\n",
    );

    let position = |s: &Sample| format!("{}:{}:{}", s.file, s.line + 1, s.col + 1);
    let differs =
        |o: Outcome| matches!(o, Outcome::Differ | Outcome::OnlyIntelephense | Outcome::OnlyEngine | Outcome::Error);
    md.push_str("\n## Differences\n");
    for query in ["definition", "hover"] {
        let rows: Vec<String> = report
            .samples
            .iter()
            .filter_map(|s| {
                let (outcome, ip, engine) = if query == "definition" {
                    (s.definition.outcome, show_targets(&s.definition.intelephense), show_targets(&s.definition.engine))
                } else {
                    (s.hover.outcome, show_hover(&s.hover.intelephense), show_hover(&s.hover.engine))
                };
                differs(outcome).then(|| format!("| `{}` | `{}` | {ip} | {engine} |", position(s), s.name))
            })
            .collect();
        let _ = writeln!(md, "\n### {query}\n");
        if rows.is_empty() {
            md.push_str("None.\n");
            continue;
        }
        md.push_str("| Position | Name | Intelephense | Engine |\n|---|---|---|---|\n");
        for row in rows.iter().take(MAX_LISTED) {
            md.push_str(row);
            md.push('\n');
        }
        if rows.len() > MAX_LISTED {
            let _ = writeln!(md, "\n… and {} more in the JSON report.", rows.len() - MAX_LISTED);
        }
    }

    let _ = writeln!(md, "\n## Intelephense answers (first {MAX_TABLE})\n");
    md.push_str("| Position | Name | Kind | Definition | Hover |\n|---|---|---|---|---|\n");
    for s in report.samples.iter().take(MAX_TABLE) {
        let _ = writeln!(
            md,
            "| `{}` | `{}` | {} | {} | {} |",
            position(s),
            s.name,
            s.kind,
            show_targets(&s.definition.intelephense),
            show_hover(&s.hover.intelephense)
        );
    }
    md
}

/// Writes `<dir>/<name>.json` and `<dir>/<name>.md` and returns their paths.
fn write_report(dir: &Path, report: &Report) -> (PathBuf, PathBuf) {
    std::fs::create_dir_all(dir).unwrap();
    let json = dir.join(format!("{}.json", report.name));
    let md = dir.join(format!("{}.md", report.name));
    std::fs::write(&json, serde_json::to_string_pretty(report).unwrap()).unwrap();
    std::fs::write(&md, markdown(report)).unwrap();
    (json, md)
}

fn report_dir() -> PathBuf {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target"));
    target.join("php-differential")
}

// ---- the two sides ----

/// The native engine's side. It has no definition or hover API yet, so every query is
/// unanswered; call the engine here once it answers them.
struct Engine;

impl Engine {
    fn definition(&self, _path: &Path, _text: &str, _pos: Pos) -> Reply<Vec<Target>> {
        Reply::Unanswered
    }

    fn hover(&self, _path: &Path, _text: &str, _pos: Pos) -> Reply<String> {
        Reply::Unanswered
    }
}

type Events = Arc<Mutex<Vec<IdeEvent>>>;

/// Intelephense, started by `ide-lsp` from the bundled `languages/php.toml`.
struct Intelephense {
    root: PathBuf,
    manager: Arc<LspManager>,
    events: Events,
}

impl Intelephense {
    fn new(root: &Path) -> Self {
        let mut php = LanguageRegistry::load(None).unwrap().get(&LanguageId::new("php")).expect("php language");
        php.language_servers.retain(|s| s.name == "intelephense");
        let events: Events = Arc::default();
        let sink = {
            let events = events.clone();
            Arc::new(move |e: IdeEvent| events.lock().unwrap().push(e))
        };
        let manager = LspManager::new(root.to_path_buf(), Arc::new(LanguageRegistry::from_configs(vec![php])), sink);
        Self { root: root.to_path_buf(), manager, events }
    }

    fn status(&self) -> Option<(ServerStatus, Option<String>)> {
        self.events.lock().unwrap().iter().rev().find_map(|e| match e {
            IdeEvent::LanguageServer { name, status, message, .. } if name == "intelephense" => {
                Some((*status, message.clone()))
            }
            _ => None,
        })
    }

    /// Waits until the server has started and finished indexing the workspace.
    async fn wait_indexed(&self, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        let mut ready_since = None;
        loop {
            match self.status() {
                Some((ServerStatus::Ready, _)) => {
                    let since = *ready_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= QUIET {
                        return;
                    }
                }
                Some((status @ (ServerStatus::Crashed | ServerStatus::Missing | ServerStatus::Misconfigured), msg)) => {
                    panic!("Intelephense is {status:?}: {msg:?} (install it with `npm i -g intelephense`)")
                }
                _ => ready_since = None,
            }
            assert!(Instant::now() < deadline, "Intelephense didn't finish indexing within {timeout:?}");
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    async fn definition(&self, doc: DocId, pos: Pos) -> Reply<Vec<Target>> {
        match tokio::time::timeout(REQUEST_TIMEOUT, self.manager.goto(doc, pos, GotoKind::Definition)).await {
            Ok(Ok(locations)) => targets(&self.root, locations),
            Ok(Err(e)) => Reply::Error(format!("{e:?}")),
            Err(_) => Reply::Error("timed out".into()),
        }
    }

    async fn hover(&self, doc: DocId, pos: Pos) -> Reply<String> {
        match tokio::time::timeout(REQUEST_TIMEOUT, self.manager.hover(doc, pos, CancellationToken::new())).await {
            Ok(Ok(Some(h))) if !h.contents.value.trim().is_empty() => Reply::Found(normalize_hover(&h.contents.value)),
            Ok(Ok(_)) => Reply::Empty,
            Ok(Err(e)) => Reply::Error(format!("{e:?}")),
            Err(_) => Reply::Error("timed out".into()),
        }
    }
}

/// Samples `n` positions under `root`, asks both sides about each, and builds the report.
async fn run(name: &str, root: &Path, n: usize, seed: u64, warm_up: Duration) -> Report {
    let sampled = sample(root, n, seed);
    assert!(!sampled.picks.is_empty(), "no identifier positions under {}", root.display());
    let intelephense = Intelephense::new(root);
    let engine = Engine;
    let php = LanguageId::new("php");
    let mut samples = Vec::new();
    let mut indexed = false;
    let mut picks = sampled.picks.iter().peekable();
    while let Some(&&(file, _)) = picks.peek() {
        let path = &sampled.files[file];
        let doc = read_document(path).expect("sampled file is readable");
        let text = doc.text();
        let id = DocId::next();
        intelephense.manager.did_open(id, path, &php, 1, &text);
        if !indexed {
            intelephense.wait_indexed(warm_up).await;
            indexed = true;
        }
        while let Some((_, c)) = picks.next_if(|(f, _)| *f == file) {
            let pos = doc.byte_to_pos(c.caret(&text));
            samples.push(Sample {
                file: relative_path(root, &path.to_string_lossy()),
                line: pos.line,
                col: pos.col,
                name: text[c.start..c.end].to_owned(),
                kind: c.kind,
                definition: Compared::new(
                    intelephense.definition(id, pos).await,
                    engine.definition(path, &text, pos),
                    |a, b| same_targets(a, b),
                ),
                hover: Compared::new(intelephense.hover(id, pos).await, engine.hover(path, &text, pos), String::eq),
            });
        }
        intelephense.manager.did_close(id);
    }
    let _ = tokio::time::timeout(Duration::from_secs(10), intelephense.manager.shutdown_all()).await;
    Report::new(name, root, seed, sampled.files.len(), sampled.candidates, samples)
}

fn env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn print_summary(report: &Report, md: &Path) {
    eprintln!(
        "{}: {} samples; definition {:?}; hover {:?}; report {}",
        report.name,
        report.samples.len(),
        report.definition,
        report.hover,
        md.display()
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Intelephense (npm i -g intelephense)"]
async fn fixture() {
    let root = dunce::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/php-app")).unwrap();
    let n = env_or("PHP_DIFF_SAMPLES", 200);
    let report = run("php-app", &root, n, env_or("PHP_DIFF_SEED", DEFAULT_SEED), Duration::from_secs(120)).await;
    let (json, md) = write_report(&report_dir(), &report);
    print_summary(&report, &md);

    assert_eq!(report.samples.len() as u64, (n as u64).min(report.candidates));
    // Until the engine answers, every sample is unanswered on its side.
    assert_eq!(report.definition.engine_unanswered, report.samples.len());
    assert_eq!(report.hover.engine_unanswered, report.samples.len());
    // The Intelephense side really ran: it resolves most names in the fixture.
    assert!(report.definition.intelephense_found * 2 > report.samples.len(), "{:?}", report.definition);
    assert!(report.hover.intelephense_found * 2 > report.samples.len(), "{:?}", report.hover);
    assert!(report.samples.iter().any(|s| matches!(&s.definition.intelephense,
        Reply::Found(t) if t.iter().any(|t| t.path == "src/functions.php"))));
    let parsed: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(json).unwrap()).unwrap();
    assert_eq!(parsed["samples"].as_array().unwrap().len(), report.samples.len());
    assert!(std::fs::read_to_string(md).unwrap().contains("| definition |"));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Intelephense and the corpora (scripts/php-corpus.sh)"]
async fn corpus() {
    let dir = std::env::var_os("PHP_CORPUS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../php-corpus"));
    let names = std::env::var("PHP_DIFF_CORPUS").unwrap_or_else(|_| "laravel-framework,symfony,wordpress".into());
    for name in names.split(',').map(str::trim).filter(|n| !n.is_empty()) {
        let root = dunce::canonicalize(dir.join(name))
            .unwrap_or_else(|e| panic!("corpus {name} under {}: {e} (run scripts/php-corpus.sh)", dir.display()));
        let report = run(
            name,
            &root,
            env_or("PHP_DIFF_SAMPLES", 200),
            env_or("PHP_DIFF_SEED", DEFAULT_SEED),
            Duration::from_secs(1200),
        )
        .await;
        let (_, md) = write_report(&report_dir(), &report);
        print_summary(&report, &md);
        assert!(report.definition.intelephense_found > 0, "{name}: Intelephense found no definitions");
    }
}

// ---- unit tests of the harness ----

fn names(source: &str) -> Vec<(&str, &'static str)> {
    candidates(source).into_iter().map(|c| (&source[c.start..c.end], c.kind)).collect()
}

#[test]
fn candidates_are_names_and_variables_outside_comments_and_strings() {
    let source = "<?php\n// Foo in a comment\n/** @var Baz */\n$x = new \\App\\Bar(); echo 'quux';\n$this->qux(Other\\Name::C);\n";
    assert_eq!(
        names(source),
        [("$x", "variable"), ("Bar", "qualified name"), ("qux", "name"), ("Name", "qualified name"), ("C", "name"),]
    );
}

#[test]
fn candidates_skip_inline_html() {
    assert_eq!(names("<p>Title</p><?= $title ?>"), [("$title", "variable")]);
}

#[test]
fn caret_positions_are_utf16_and_inside_the_name() {
    let source = "<?php\n$é = 'ü'; strlen($é);\n";
    let doc = Document::new(source);
    let text = doc.text();
    let found = candidates(&text);
    let call = found.iter().find(|c| &text[c.start..c.end] == "strlen").unwrap();
    // `$é = 'ü'; ` is 10 UTF-16 units; the caret sits in the middle of `strlen`.
    assert_eq!(doc.byte_to_pos(call.caret(&text)), Pos::new(1, 13));
    let var = found.iter().find(|c| c.start > call.start).unwrap();
    let caret = var.caret(&text);
    assert!(text.is_char_boundary(caret) && caret >= var.start && caret < var.end);
}

#[test]
fn sampling_is_deterministic_bounded_and_ordered() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.php"), "<?php\nfunction a($x) { return b($x) + c(); }\n").unwrap();
    std::fs::create_dir(dir.path().join("vendor")).unwrap();
    std::fs::write(dir.path().join("vendor/v.php"), "<?php\nv();\n").unwrap();
    std::fs::write(dir.path().join("b.php"), "<?php\n$y = new Foo(BAR);\n").unwrap();
    std::fs::write(dir.path().join("notes.txt"), "not php").unwrap();

    let all = sample(dir.path(), 100, 1);
    assert_eq!(all.files.len(), 2, "vendor/ and non-PHP files are skipped");
    assert_eq!(all.candidates, 8);
    assert_eq!(all.picks.len(), 8);
    let some = sample(dir.path(), 4, 7);
    assert_eq!(some.picks.len(), 4);
    assert_eq!(some.picks, sample(dir.path(), 4, 7).picks);
    assert!(some.picks.windows(2).all(|w| (w[0].0, w[0].1.start) < (w[1].0, w[1].1.start)));
    assert!((0..20).any(|seed| sample(dir.path(), 4, seed).picks != some.picks), "the seed changes the sample");
}

#[test]
fn reservoir_is_roughly_uniform() {
    let mut hits = [0u32; 10];
    for seed in 0..2000 {
        let mut r = Reservoir::new(3, seed);
        (0..10).for_each(|i| r.offer(i));
        r.items.iter().for_each(|&i| hits[i] += 1);
    }
    // Each item is kept with probability 3/10: 600 of 2000 runs.
    assert!(hits.iter().all(|&h| (480..=720).contains(&h)), "{hits:?}");
}

fn target(path: &str, line: u32, col: u32) -> Target {
    Target { path: path.into(), line, col }
}

#[test]
fn outcomes() {
    let found = |l| Reply::Found(vec![target("a.php", l, 0)]);
    assert_eq!(compare(&found(1), &Reply::Unanswered, |a, b| same_targets(a, b)), Outcome::EngineUnanswered);
    assert_eq!(compare(&found(1), &found(1), |a, b| same_targets(a, b)), Outcome::Agree);
    assert_eq!(compare(&found(1), &found(2), |a, b| same_targets(a, b)), Outcome::Differ);
    assert_eq!(compare(&found(1), &Reply::Empty, |a, b| same_targets(a, b)), Outcome::OnlyIntelephense);
    assert_eq!(compare(&Reply::Empty, &found(1), |a, b| same_targets(a, b)), Outcome::OnlyEngine);
    assert_eq!(compare::<Vec<Target>>(&Reply::Empty, &Reply::Empty, |a, b| same_targets(a, b)), Outcome::BothEmpty);
    assert_eq!(compare(&Reply::Error("x".into()), &found(1), |a, b| same_targets(a, b)), Outcome::Error);
    assert_eq!(compare(&found(1), &Reply::Error("x".into()), |a, b| same_targets(a, b)), Outcome::Error);
}

#[test]
fn definitions_agree_on_file_and_line_but_not_column() {
    assert!(same_targets(&[target("a.php", 3, 4)], &[target("a.php", 3, 9)]));
    assert!(!same_targets(&[target("a.php", 3, 4)], &[target("b.php", 3, 4)]));
    assert!(!same_targets(&[target("a.php", 3, 4)], &[target("a.php", 3, 4), target("a.php", 8, 0)]));
}

#[test]
fn hover_whitespace_is_normalized() {
    assert_eq!(normalize_hover("```php\n<?php\nfunction  f(): int\n```\n\n"), "```php <?php function f(): int ```");
}

#[test]
fn definition_paths_are_relative_to_the_root() {
    let root = Path::new("D:\\work\\app");
    assert_eq!(relative_path(root, "d:\\work\\app\\src\\A.php"), "src/A.php");
    assert_eq!(relative_path(Path::new("/w/app"), "/w/app/src/A.php"), "src/A.php");
    assert_eq!(relative_path(Path::new("/w/app"), "/w/application/A.php"), "/w/application/A.php");
    assert_eq!(relative_path(Path::new("/w/app"), "/opt/stubs/core.php"), "/opt/stubs/core.php");
}

fn sample_row(name: &str, definition: Reply<Vec<Target>>, engine: Reply<Vec<Target>>, hover: Reply<String>) -> Sample {
    Sample {
        file: "src/A.php".into(),
        line: 4,
        col: 9,
        name: name.into(),
        kind: "name",
        definition: Compared::new(definition, engine, |a, b| same_targets(a, b)),
        hover: Compared::new(hover, Reply::Unanswered, String::eq),
    }
}

#[test]
fn report_tallies_and_renders() {
    let samples = vec![
        sample_row(
            "a",
            Reply::Found(vec![target("src/B.php", 2, 6)]),
            Reply::Unanswered,
            Reply::Found("function a()".into()),
        ),
        sample_row(
            "b",
            Reply::Found(vec![target("src/B.php", 2, 6)]),
            Reply::Found(vec![target("src/B.php", 2, 0)]),
            Reply::Empty,
        ),
        sample_row("c", Reply::Found(vec![target("src/C.php", 7, 0)]), Reply::Empty, Reply::Found("x | y".into())),
        sample_row("d", Reply::Empty, Reply::Empty, Reply::Error("timed out".into())),
    ];
    let report = Report::new("unit", Path::new("/w/app"), 3, 2, 40, samples);
    assert_eq!(
        report.definition,
        Tally {
            agree: 1,
            only_intelephense: 1,
            both_empty: 1,
            engine_unanswered: 1,
            intelephense_found: 3,
            ..Tally::default()
        }
    );
    assert_eq!(report.definition.agreement(), Some(50.0));
    assert_eq!(report.hover.engine_unanswered, 4);
    assert_eq!(report.hover.agreement(), None);

    let md = markdown(&report);
    assert!(md.contains("# PHP differential report: unit"), "{md}");
    assert!(md.contains("| definition | 1 | 0 | 1 | 0 | 1 | 1 | 0 | 3 | 50.0% |"), "{md}");
    assert!(md.contains("| hover | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 2 | n/a |"), "{md}");
    assert!(md.contains("| `src/A.php:5:10` | `c` | src/C.php:8 | — |"), "{md}");
    assert!(md.contains("x \\| y"), "table cells escape pipes: {md}");

    let dir = tempfile::tempdir().unwrap();
    let (json, md_path) = write_report(dir.path(), &report);
    assert_eq!(md_path, dir.path().join("unit.md"));
    let parsed: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(json).unwrap()).unwrap();
    assert_eq!(parsed["definition"]["onlyIntelephense"], 1);
    assert_eq!(parsed["samples"][0]["definition"]["engine"]["reply"], "unanswered");
    assert_eq!(parsed["samples"][1]["definition"]["outcome"], "agree");
    assert_eq!(parsed["samples"][2]["definition"]["intelephense"]["value"][0]["path"], "src/C.php");
}
