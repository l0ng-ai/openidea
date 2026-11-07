//! Differential test: the native engine against Intelephense.
//!
//! Over N identifier positions sampled from a PHP project, it asks Intelephense (through
//! `ide-lsp`, the way the app does) and the engine for go to definition and hover, and writes a
//! JSON and a Markdown report of where they agree and differ to `target/php-differential/`.
//! The engine indexes the same root into a temporary cache and is asked through
//! `PhpEngine::definition` and `PhpEngine::hover`, the API the app's `PhpService` uses.
//! Definitions agree on file and line (built-ins: on both going to a stub); hovers agree when
//! they are about the same declaration, or the same variable with the same type (see
//! [`HoverKey`]). The corpus summary is kept in `docs/php-engine/differential.md`.
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
use ide_core::{CancellationToken, DocId, IdeEvent, LanguageId, Location, Pos, SharedSink};
use ide_language::LanguageRegistry;
use ide_lsp::LspManager;
use ide_lsp::types::GotoKind;
use ide_php::engine::{CACHE_SUBDIR, EngineConfig, PhpEngine};
use ide_php::mago::database::file::FileId;
use ide_php::mago::syntax::lexer::Lexer;
use ide_php::mago::syntax::settings::LexerSettings;
use ide_php::mago::syntax::token::TokenKind;
use ide_php::mago::syntax_core::input::Input;
use ide_php::project::LayoutConfig;
use ide_php::stubs::StubFilter;
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
/// The agreement the fixture run must reach on each query (phase 6.2's bar).
const FIXTURE_AGREEMENT: f64 = 98.0;

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

/// Definitions agree when the engine names some of the lines of the same files Intelephense
/// names: servers differ on whether a target is the declaration's name or its first token, and
/// Intelephense answers the class name in `new Foo(…)` with both the class and its constructor
/// where the engine (like PhpStorm's Ctrl+Click on the class name) gives the class.
fn same_targets(intelephense: &[Target], engine: &[Target]) -> bool {
    let lines = |t: &[Target]| t.iter().map(|t| (t.path.clone(), t.line)).collect::<BTreeSet<_>>();
    let engine = lines(engine);
    !engine.is_empty() && engine.is_subset(&lines(intelephense))
}

/// Hover text with whitespace runs collapsed, so line wrapping doesn't count as a difference.
fn normalize_hover(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// What a hover is about, read from the two sides' Markdown: a declaration by its qualified
/// name, or a variable by its name and type. The two sides format hovers differently
/// (Intelephense heads with `__App\\Foo::bar__` and shows variables as `_@var_ `T $x``; the
/// engine shows the declaration in a code block under its container), so hovers agree when
/// they are about the same thing, not when their text matches.
#[derive(Clone, Debug, PartialEq, Eq)]
enum HoverKey {
    /// A class-like, function, constant or member: `app\foo`, `app\foo::bar`, `app\foo::$p`,
    /// lower-cased (PHP compares most of these case-insensitively) without a leading `\`.
    Symbol(String),
    /// A variable or parameter: its name without `$` and its type in a canonical form.
    Variable { name: String, ty: String },
    /// Neither: compared as text.
    Other(String),
}

fn symbol_key(name: &str) -> HoverKey {
    HoverKey::Symbol(name.trim().trim_start_matches('\\').to_lowercase())
}

/// A type written by either side, in one form, so hovers agree when the two sides mean the same
/// type at the precision both have:
///
/// - union members without leading `\`, lower-cased, sorted and deduplicated, `?T` as `T|null`,
///   parenthesized members unwrapped, parameter names in callable signatures dropped;
/// - every array type (`array`, `T[]`, `list<T>`, `array<K, V>`, shapes, `non-empty-*`) as
///   `array`: Intelephense shows its own shapes and `T[]`, the engine its shapes, lists and
///   generalized loop arrays, and neither is wrong where they differ;
/// - refinements as their base type (`non-negative-int`, `int<0, max>` → `int`,
///   `non-empty-string`, `class-string<T>` → `string`, `array-key` → `int|string`), and
///   `boolean`/`integer`/`double` as `bool`/`int`/`float`; a lone `true`/`false` as `bool`
///   (the engine widens a literal on its own, Intelephense shows it); a union with `mixed` as
///   `mixed`;
/// - generic class arguments in the same form.
fn canonical_type(ty: &str) -> String {
    let ty = without_param_names(&ty.trim().to_lowercase());
    let (ty, nullable) = match ty.strip_prefix('?') {
        Some(rest) => (rest.to_owned(), true),
        None => (ty, false),
    };
    let mut members: Vec<String> = split_top_level(&ty, '|')
        .into_iter()
        .map(canonical_member)
        .flat_map(|member| split_top_level(&member, '|').into_iter().map(str::to_owned).collect::<Vec<_>>())
        .collect();
    if nullable {
        members.push("null".into());
    }
    // `mixed|null` is `mixed`.
    if members.iter().any(|m| m == "mixed") {
        return "mixed".into();
    }
    members.sort();
    members.dedup();
    let joined = members.join("|");
    match joined.as_str() {
        "true" | "false" => "bool".into(),
        _ => joined,
    }
}

fn canonical_member(member: &str) -> String {
    let member = without_leading_backslashes(member.trim());
    let member = member.as_str();
    // `(A|B)`: parentheses around the whole member.
    if member.starts_with('(') && member.ends_with(')') {
        let mut depth = 0;
        let closes_at = member.char_indices().find_map(|(i, c)| {
            depth += match c {
                '(' => 1,
                ')' => -1,
                _ => 0,
            };
            (depth == 0).then_some(i)
        });
        if closes_at == Some(member.len() - 1) {
            return canonical_type(&member[1..member.len() - 1]);
        }
    }
    let name_end = member.find(['<', '{', '(']).unwrap_or(member.len());
    let name = &member[..name_end];
    if member.ends_with("[]") || matches!(name, "array" | "list" | "non-empty-array" | "non-empty-list") {
        return "array".into();
    }
    if name == "int"
        || matches!(name, "positive-int" | "negative-int" | "non-negative-int" | "non-positive-int" | "non-zero-int")
    {
        return "int".into();
    }
    if name.ends_with("-string") {
        return "string".into();
    }
    if let Some(args) = member[name_end..].strip_prefix('<').and_then(|rest| rest.strip_suffix('>')) {
        let args: Vec<String> = split_top_level(args, ',').into_iter().map(canonical_type).collect();
        return format!("{name}<{}>", args.join(", "));
    }
    match member {
        "array-key" => "int|string".into(),
        "boolean" => "bool".into(),
        "integer" => "int".into(),
        "double" => "float".into(),
        _ => member.to_owned(),
    }
}

/// `\Foo\Bar` as `Foo\Bar` wherever a name starts (`array{a: \Foo}`, `Box<\Foo>`).
fn without_leading_backslashes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        let starts_name = !out.chars().next_back().is_some_and(|p: char| p.is_alphanumeric() || p == '_');
        if !(c == '\\' && starts_name) {
            out.push(c);
        }
    }
    out
}

/// `callable(T $t): U` as `callable(T): U`: parameter names in callable signatures are left
/// out by one side and not part of the type.
fn without_param_names(ty: &str) -> String {
    let mut out = String::with_capacity(ty.len());
    let mut chars = ty.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '$' {
            while chars.peek().is_some_and(|c| c.is_alphanumeric() || *c == '_') {
                chars.next();
            }
            while out.ends_with(' ') {
                out.pop();
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Splits on `sep` outside `<…>`, `(…)`, `{…}` and `[…]`.
fn split_top_level(text: &str, sep: char) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    for (i, c) in text.char_indices() {
        match c {
            '<' | '(' | '{' | '[' => depth += 1,
            '>' | ')' | '}' | ']' => depth -= 1,
            c if c == sep && depth == 0 => {
                out.push(&text[start..i]);
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    out.push(&text[start..]);
    out
}

/// `T $name`, `T &...$name = default` → `(name, T)`; modifiers in front (promoted
/// parameters) are dropped.
fn typed_variable(text: &str) -> Option<HoverKey> {
    let text = text.split(" = ").next()?.trim();
    let dollar = text.rfind('$')?;
    let name: String = text[dollar + 1..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    if name.is_empty() {
        return None;
    }
    let ty = text[..dollar].trim_end_matches(['&', '.', ' ']);
    let ty = ty
        .split(' ')
        .filter(|w| !matches!(*w, "public" | "protected" | "private" | "readonly" | "static" | "var" | ""))
        .collect::<Vec<_>>()
        .join(" ");
    let ty = if ty.is_empty() { "mixed".to_owned() } else { canonical_type(&ty) };
    Some(HoverKey::Variable { name, ty })
}

/// Intelephense's hover: `__Name__ …` for declarations, `_@var_ `T $x`` / `_@param_ `T $x``
/// for variables.
fn intelephense_hover_key(text: &str) -> HoverKey {
    let text = text.trim();
    // The closing `__` is the first not escaped (`__\_\___` is the function `__`).
    let closing = |rest: &str| {
        let bytes = rest.as_bytes();
        (0..bytes.len().saturating_sub(1))
            .find(|&i| bytes[i] == b'_' && bytes[i + 1] == b'_' && (i == 0 || bytes[i - 1] != b'\\'))
    };
    if let Some(rest) = text.strip_prefix("__")
        && let Some(end) = closing(rest)
    {
        let name = rest[..end].replace("\\_", "_").replace("\\\\", "\\").replace("\\$", "$");
        return symbol_key(&name);
    }
    for tag in ["_@var_ `", "_@param_ `"] {
        if let Some(rest) = text.strip_prefix(tag)
            && let Some(key) = rest.split('`').next().and_then(typed_variable)
        {
            return key;
        }
    }
    HoverKey::Other(text.to_owned())
}

/// The engine's hover: an optional `` `container` `` line, then the code block
/// (`namespace N;` and a declaration, or `T $name`).
fn engine_hover_key(text: &str) -> HoverKey {
    let text = text.trim();
    let container = if text.starts_with("```") { None } else { text.strip_prefix('`').and_then(|t| t.split_once('`')) };
    let (container, rest) = match container {
        Some((container, rest)) => (Some(container), rest),
        None => (None, text),
    };
    let code = rest.split("```php").nth(1).and_then(|c| c.split("```").next()).unwrap_or("");
    let code = code.trim().trim_start_matches("<?php").trim();
    let (namespace, decl) = match code.strip_prefix("namespace ").and_then(|c| c.split_once(';')) {
        Some((namespace, decl)) => (Some(namespace.trim()), decl.trim()),
        None => (None, code),
    };
    let qualify = |name: &str| match (container, namespace) {
        (Some(container), _) => symbol_key(&format!("{container}::{name}")),
        (None, Some(namespace)) => symbol_key(&format!("{namespace}\\{name}")),
        (None, None) => symbol_key(name),
    };
    let ident = |s: &str| s.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect::<String>();
    // A parameter: its container is the function (`f()`, `C::m()`).
    if container.is_some_and(|c| c.ends_with("()")) {
        return typed_variable(decl).unwrap_or_else(|| HoverKey::Other(text.to_owned()));
    }
    let words: Vec<&str> = decl.split_whitespace().collect();
    for (i, word) in words.iter().enumerate() {
        let next = words.get(i + 1).copied().unwrap_or("");
        match *word {
            "class" | "interface" | "trait" | "enum" | "case" => return qualify(&ident(next)),
            "function" => return qualify(&ident(next.trim_start_matches('&'))),
            "const" => {
                // `const NAME = …` or a typed class constant `const int NAME = …`.
                let after = &words[i + 1..];
                let name = after.iter().position(|w| *w == "=").and_then(|eq| eq.checked_sub(1)).map(|n| after[n]);
                return qualify(&ident(name.unwrap_or(next)));
            }
            _ => {}
        }
    }
    match container {
        // A property: `public T $name`.
        Some(_) => match typed_variable(decl) {
            Some(HoverKey::Variable { name, .. }) => qualify(&format!("${name}")),
            _ => HoverKey::Other(text.to_owned()),
        },
        None => typed_variable(decl).unwrap_or_else(|| HoverKey::Other(text.to_owned())),
    }
}

/// Whether two hovers are about the same declaration, or the same variable with the same type.
fn same_hover(intelephense: &str, engine: &str) -> bool {
    intelephense_hover_key(intelephense) == engine_hover_key(engine)
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

/// What a definition outside the project root is compared as. Outside the root there are only
/// built-in declarations (the corpora and the fixture have no `vendor/`), and the two sides
/// bundle different stub files (Intelephense's own and phpstorm-stubs), whose paths and lines
/// can't match: they agree when both go to a built-in for the same name.
const BUILTIN: &str = "<built-in stubs>";

/// A definition target, relative to `root` when inside it, else [`BUILTIN`].
fn target(root: &Path, path: &str, line: u32, col: u32) -> Target {
    let path = relative_path(root, path);
    let outside = path.starts_with('/') || path.contains(':');
    if outside { Target { path: BUILTIN.into(), line: 0, col: 0 } } else { Target { path, line, col } }
}

fn lsp_targets(root: &Path, locations: Vec<Location>) -> Reply<Vec<Target>> {
    targets(
        locations
            .into_iter()
            .map(|l| {
                let path = l.uri.clone().unwrap_or_else(|| l.path.to_string_lossy().into_owned());
                target(root, &path, l.range.start.line, l.range.start.col)
            })
            .collect(),
    )
}

fn targets(mut out: Vec<Target>) -> Reply<Vec<Target>> {
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
         Definitions agree when they name the same lines of the same files (built-in declarations: \
         when both go to a stub); hovers agree when they are about the same declaration, or the same \
         variable with the same type. Positions below are 1-based `file:line:col`.\n",
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

/// The native engine's side: a [`PhpEngine`] over the same root, with its index in a
/// temporary cache directory, asked through the same API the `PhpService` of ide-host uses.
struct Engine {
    root: PathBuf,
    engine: Arc<PhpEngine>,
    _cache: tempfile::TempDir,
}

impl Engine {
    /// Opens the engine on `root` and waits until it has indexed it.
    fn open(root: &Path, timeout: Duration) -> Self {
        let cache = tempfile::tempdir().unwrap();
        let config = EngineConfig {
            cache_dir: cache.path().join(CACHE_SUBDIR),
            layout: LayoutConfig { root: root.to_path_buf(), ..LayoutConfig::default() },
            stubs: StubFilter::default(),
        };
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        let engine = PhpEngine::open(config, sink).unwrap();
        assert!(engine.wait_idle(timeout), "the engine didn't index {} within {timeout:?}", root.display());
        Self { root: root.to_path_buf(), engine, _cache: cache }
    }

    fn opened(&self, doc: DocId, path: &Path, text: &str) {
        self.engine.document_opened(doc, path, 1, text);
    }

    fn closed(&self, doc: DocId) {
        self.engine.document_closed(doc);
    }

    fn definition(&self, doc: DocId, pos: Pos) -> Reply<Vec<Target>> {
        let found = self.engine.definition(doc, pos).unwrap_or_default();
        let locations = found
            .into_iter()
            .map(|t| target(&self.root, &t.path.to_string_lossy(), t.range.start.line, t.range.start.col))
            .collect();
        targets(locations)
    }

    fn hover(&self, doc: DocId, pos: Pos) -> Reply<String> {
        match self.engine.hover(doc, pos) {
            Some(h) if !h.markdown.trim().is_empty() => Reply::Found(normalize_hover(&h.markdown)),
            _ => Reply::Empty,
        }
    }

    fn shutdown(&self) {
        self.engine.shutdown();
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
            Ok(Ok(locations)) => lsp_targets(&self.root, locations),
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
    let engine = Engine::open(root, warm_up);
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
        engine.opened(id, path, &text);
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
                    engine.definition(id, pos),
                    |a, b| same_targets(a, b),
                ),
                hover: Compared::new(intelephense.hover(id, pos).await, engine.hover(id, pos), |a, b| same_hover(a, b)),
            });
        }
        intelephense.manager.did_close(id);
        engine.closed(id);
    }
    engine.shutdown();
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
    // The engine answers every sample and agrees with Intelephense on nearly all of them.
    for (query, tally) in [("definition", &report.definition), ("hover", &report.hover)] {
        assert_eq!(tally.engine_unanswered + tally.error, 0, "{query}: {tally:?}");
        let agreement = tally.agreement().unwrap_or(0.0);
        assert!(agreement >= FIXTURE_AGREEMENT, "{query}: {agreement:.1}% agreement, {tally:?}; see {}", md.display());
    }
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

fn at(path: &str, line: u32, col: u32) -> Target {
    Target { path: path.into(), line, col }
}

#[test]
fn outcomes() {
    let found = |l| Reply::Found(vec![at("a.php", l, 0)]);
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
    assert!(same_targets(&[at("a.php", 3, 4)], &[at("a.php", 3, 9)]));
    assert!(!same_targets(&[at("a.php", 3, 4)], &[at("b.php", 3, 4)]));
    assert!(!same_targets(&[at("a.php", 3, 4)], &[at("a.php", 3, 4), at("a.php", 8, 0)]));
    // `new Foo`: Intelephense gives the class and its constructor, the engine the class.
    assert!(same_targets(&[at("a.php", 3, 4), at("a.php", 8, 0)], &[at("a.php", 3, 4)]));
    assert!(!same_targets(&[at("a.php", 3, 4)], &[]));
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
            Reply::Found(vec![at("src/B.php", 2, 6)]),
            Reply::Unanswered,
            Reply::Found("function a()".into()),
        ),
        sample_row(
            "b",
            Reply::Found(vec![at("src/B.php", 2, 6)]),
            Reply::Found(vec![at("src/B.php", 2, 0)]),
            Reply::Empty,
        ),
        sample_row("c", Reply::Found(vec![at("src/C.php", 7, 0)]), Reply::Empty, Reply::Found("x | y".into())),
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

#[test]
fn intelephense_hovers_name_their_subject() {
    let sym = |s: &str| HoverKey::Symbol(s.into());
    let var = |n: &str, t: &str| HoverKey::Variable { name: n.into(), ty: t.into() };
    let key = |text: &str| intelephense_hover_key(&normalize_hover(text));
    assert_eq!(key("__App\\\\Library__\n\n```php\n<?php\nfinal class Library { }\n```"), sym("app\\library"));
    assert_eq!(key("__App\\\\Library::\\_\\_construct__\n```php\n```"), sym("app\\library::__construct"));
    assert_eq!(key("__App\\\\Container::$factories__"), sym("app\\container::$factories"));
    assert_eq!(key("__printf__ Output a formatted string"), sym("printf"));
    assert_eq!(key("__\\_\\___ Retrieves the translation"), sym("__"));
    assert_eq!(key("__App\\\\\\_\\_foo__ text"), sym("app\\__foo"));
    assert_eq!(key("_@var_ `\\App\\Library $library`"), var("library", "app\\library"));
    assert_eq!(key("_@param_ `?\\App\\Model\\Book $book`"), var("book", "app\\model\\book|null"));
    assert_eq!(key("_@var_ `string|\\App\\Book[] $x`"), var("x", "array|string"));
    assert_eq!(key("_@param_ `callable(T $t, int &...$n): U $fn`"), var("fn", "callable(t, int &...): u"));
    assert_eq!(
        key("_@var_ `\\Box<string, string|string> $c`"),
        key("_@var_ `Box<string,string> $c`"),
        "generic arguments are canonical too"
    );
    assert_eq!(key("_@var_ `array{a: \\Foo\\Bar, b: (int|string)[]} $s`"), var("s", "array"));
    assert_eq!(key("_@var_ `array<int, \\Foo> $s`"), var("s", "array"));
    assert_eq!(key("_@var_ `(\\Foo|null)[] $s`"), var("s", "array"));
    assert_eq!(
        key("_@var_ `non-negative-int|array-key|non-empty-string|class-string<\\Foo> $s`"),
        var("s", "int|string")
    );
    assert_eq!(key("_@var_ `false $f`"), var("f", "bool"));
    assert_eq!(key("_@var_ `mixed|null $m`"), var("m", "mixed"));
    assert_eq!(key("_@var_ `int|false $f`"), var("f", "false|int"));
    assert_eq!(key("plain"), HoverKey::Other("plain".into()));
}

#[test]
fn engine_hovers_name_their_subject() {
    let sym = |s: &str| HoverKey::Symbol(s.into());
    let var = |n: &str, t: &str| HoverKey::Variable { name: n.into(), ty: t.into() };
    let key = |text: &str| engine_hover_key(&normalize_hover(text));
    let code = |code: &str| format!("```php\n<?php\n{code}\n```");
    let member = |container: &str, code_: &str| format!("`{container}`\n\n{}\n\n---\n\nDocs.", code(code_));
    assert_eq!(key(&code("namespace App;\nfinal class Library")), sym("app\\library"));
    assert_eq!(key(&code("namespace App\\Model;\nenum Genre: string")), sym("app\\model\\genre"));
    assert_eq!(key(&code("function printf(string $format, mixed ...$values): int")), sym("printf"));
    assert_eq!(key(&code("namespace App;\nfunction &slugify(string $s): string")), sym("app\\slugify"));
    assert_eq!(key(&code("namespace App;\nconst LIMIT = 10;")), sym("app\\limit"));
    assert_eq!(key(&member("App\\Library", "public function add(Book $book): void")), sym("app\\library::add"));
    assert_eq!(key(&member("App\\Model\\Genre", "case Fiction = 'fiction';")), sym("app\\model\\genre::fiction"));
    assert_eq!(key(&member("App\\Box", "public final const int MAX = 3;")), sym("app\\box::max"));
    assert_eq!(key(&member("App\\Container", "private array $factories")), sym("app\\container::$factories"));
    assert_eq!(
        key(&member("App\\Library::__construct()", "private BookRepository $books")),
        var("books", "bookrepository")
    );
    assert_eq!(key(&member("App\\f()", "int ...$n = 3")), var("n", "int"));
    assert_eq!(key(&code("list<\\App\\Book>|null $books")), var("books", "array|null"));
    assert_eq!(key(&code("$x")), var("x", "mixed"));
}

#[test]
fn hovers_agree_on_their_subject_not_their_text() {
    let class = "```php\n<?php\nnamespace App;\nfinal class Library\n```";
    assert!(same_hover("__App\\\\Library__ ```php <?php final class Library { } ```", &normalize_hover(class)));
    assert!(!same_hover("__App\\\\Book__", &normalize_hover(class)));
    assert!(same_hover("_@var_ `\\App\\Book[] $b`", &normalize_hover("```php\n<?php\nlist<App\\Book> $b\n```")));
    assert!(!same_hover("_@var_ `\\App\\Book $b`", &normalize_hover("```php\n<?php\nmixed $b\n```")));
}

#[test]
fn definitions_outside_the_root_are_built_ins() {
    let root = Path::new("/w/app");
    assert_eq!(target(root, "/w/app/src/A.php", 3, 4), at("src/A.php", 3, 4));
    assert_eq!(target(root, "C:/npm/intelephense/lib/stub/standard/standard_2.php", 360, 9), at(BUILTIN, 0, 0));
    assert_eq!(target(root, "/home/u/.cache/php/stubs/v1/standard/basic.php", 7, 0), at(BUILTIN, 0, 0));
    assert!(same_targets(&[target(root, "/a/stub.php", 1, 0)], &[target(root, "/b/other.php", 9, 3)]));
}
