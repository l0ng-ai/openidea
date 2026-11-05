//! Language smoke tests: the everyday code intelligence of each language — completion, go to
//! definition, Find Usages, hover, diagnostics with a quick fix, an intention, rename,
//! formatting, parameter info, the Structure view, auto-import, Optimize Imports and moving a
//! file — on its `fixtures/` project, through the `ops` the app's commands call and the
//! language server the app starts by default.
//!
//! `#[ignore]`d because they need the servers installed. CI's `Language smoke` job installs
//! pinned versions and runs one language per job:
//! `cargo test -p ide-host --test language_smoke -- --ignored --exact <language>`.

use ide_core::{ChangeSet, DocId, IdeEvent, Pos, Range, RequestId, TextChange};
use ide_host::{Host, HostConfig, ops};
use ide_lsp::types::{FormatOptions, GotoKind};
use std::collections::BTreeSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const WINDOW: &str = "main";

/// `word` on the first line of `file` that contains `line`.
#[derive(Clone, Copy, Debug)]
struct At {
    file: &'static str,
    line: &'static str,
    word: &'static str,
}

const fn at(file: &'static str, line: &'static str, word: &'static str) -> At {
    At { file, line, word }
}

/// A line typed after the first line of `file` containing `after`.
#[derive(Clone, Copy, Debug)]
struct Typed {
    file: &'static str,
    after: &'static str,
    text: &'static str,
}

const fn typed(file: &'static str, after: &'static str, text: &'static str) -> Typed {
    Typed { file, after, text }
}

/// One language's checklist. Every check names what it looks for, so a failure says which
/// operation broke.
struct Checks {
    fixture: &'static str,
    /// Files written into the project copy before it opens.
    files: &'static [(&'static str, &'static str)],
    /// How long the first answer may take (project import and indexing).
    warm_up: Duration,
    /// Go to definition from the first spot lands on the second.
    definition: (At, At),
    /// Find Usages of the symbol lists usages in these files.
    references: (At, &'static [&'static str]),
    /// Hover shows this text.
    hover: (At, &'static str),
    /// Completion at the end of the typed line offers this item.
    completion: (Typed, &'static str),
    /// A file of the project is reported with this diagnostic as it opens (one it already has,
    /// not a typed one).
    diagnostic: Option<(&'static str, &'static str)>,
    /// The typed line is reported with this diagnostic; the quick fix with this title makes the
    /// file contain the last text.
    quick_fix: Option<QuickFix>,
    /// With the word selected, this intention is offered with an edit or command.
    intention: Option<(At, &'static str)>,
    /// Formatting turns the typed line into the expected one.
    format: (Typed, &'static str),
    indent: Indent,
    /// Renaming the symbol to the new name edits these files.
    rename: Option<(At, &'static str, &'static [&'static str])>,
    /// Parameter info in a call being typed: a signature naming this parameter.
    signature: (Typed, &'static str),
    /// The Structure view of a file: these symbols, at any depth.
    outline: (&'static str, &'static [&'static str]),
    /// Completing a name the file doesn't import yet also imports it.
    auto_import: AutoImport,
    /// Optimize Imports, with an import typed after a line.
    organize_imports: Option<(Typed, Imports)>,
    /// Moving a file updates its references: (file, new path, a file that then contains this).
    file_move: Option<(&'static str, &'static str, &'static str, &'static str)>,
}

#[derive(Clone, Copy, Debug)]
struct AutoImport {
    /// The line typed, ending in the start of the name.
    typed: Typed,
    /// The completion item.
    label: &'static str,
    /// What the item's import adds to the file.
    result: &'static str,
}

/// What Optimize Imports does with the typed import.
#[derive(Clone, Copy, Debug)]
enum Imports {
    /// Removes it (unused).
    Removed,
    /// Sorts it before this line.
    Before(&'static str),
}

#[derive(Clone, Copy, Debug)]
struct QuickFix {
    typed: Typed,
    diagnostic: &'static str,
    title: &'static str,
    result: &'static str,
}

/// The editor's indentation, sent with a format request.
#[derive(Clone, Copy, Debug)]
enum Indent {
    Spaces(u32),
    Tabs,
}

type Events = Arc<Mutex<Vec<IdeEvent>>>;

struct Smoke {
    language: &'static str,
    host: Arc<Host>,
    root: PathBuf,
    events: Events,
    warm_up: Duration,
    _tmp: tempfile::TempDir,
}

fn fixture_dir(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(name)
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        if matches!(name.to_str(), Some("node_modules" | "target" | "build" | ".gradle" | ".venv")) {
            continue;
        }
        let target = to.join(&name);
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// The 0-based line index and text of the first line containing `needle`.
fn find_line<'a>(text: &'a str, needle: &str, what: &str) -> (u32, &'a str) {
    text.lines()
        .enumerate()
        .find(|(_, l)| l.contains(needle))
        .map(|(i, l)| (i as u32, l))
        .unwrap_or_else(|| panic!("{what}: no line containing {needle:?}"))
}

/// The byte offset of `word` in `line`, not as part of a longer identifier (`parse` in `parser::parse`).
fn find_word(line: &str, word: &str) -> Option<usize> {
    let ident = |c: char| c.is_alphanumeric() || c == '_';
    line.match_indices(word).map(|(i, _)| i).find(|&i| {
        let before = line[..i].chars().next_back();
        let after = line[i + word.len()..].chars().next();
        !(word.starts_with(ident) && before.is_some_and(ident)) && !(word.ends_with(ident) && after.is_some_and(ident))
    })
}

impl Smoke {
    async fn start(language: &'static str, checks: &Checks) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap().join(checks.fixture);
        copy_dir(&fixture_dir(checks.fixture), &root);
        for (path, text) in checks.files {
            let path = root.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let events: Events = Arc::default();
        let app = tmp.path().join("app");
        let host = Arc::new(Host::new(HostConfig {
            config_dir: app.join("config"),
            data_dir: app.join("data"),
            local_data_dir: app.join("data"),
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
        Smoke { language, host, root, events, warm_up: checks.warm_up, _tmp: tmp }
    }

    fn fail(&self, check: &str, message: impl std::fmt::Display) -> ! {
        let servers = ops::lsp::lsp_servers(&self.host, WINDOW).unwrap_or_default();
        let servers: Vec<String> = servers.iter().map(|s| format!("{} ({:?})", s.name, s.status)).collect();
        panic!("{} — {check}: {message}\nservers: {servers:?}", self.language)
    }

    /// Retries `f` until it succeeds (servers answer emptily while importing and indexing); on
    /// timeout, fails with its last answer.
    async fn retry<T, D: std::fmt::Debug, F: Future<Output = Result<T, D>>>(
        &self,
        check: &str,
        timeout: Duration,
        mut f: impl FnMut() -> F,
    ) -> T {
        let deadline = Instant::now() + timeout;
        loop {
            let last = match f().await {
                Ok(v) => return v,
                Err(last) => last,
            };
            if Instant::now() > deadline {
                self.fail(check, format_args!("timed out after {timeout:?}; last answer: {last:?}"));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn doc(&self, file: &str) -> (DocId, String) {
        let info = ops::doc::open(&self.host, WINDOW, self.root.join(file)).await.unwrap();
        let info = ops::doc::snapshot(&self.host, WINDOW, info.id).await.unwrap();
        (info.id, info.text)
    }

    async fn locate(&self, at: At) -> (DocId, Pos) {
        let (doc, text) = self.doc(at.file).await;
        let (line, content) = find_line(&text, at.line, at.file);
        let col = find_word(content, at.word).unwrap_or_else(|| panic!("{at:?}: word not on the line"));
        (doc, Pos::new(line, utf16_len(&content[..col])))
    }

    async fn word_range(&self, at: At) -> (DocId, Range) {
        let (doc, start) = self.locate(at).await;
        (doc, Range::new(start, Pos::new(start.line, start.col + utf16_len(at.word))))
    }

    /// Types a new line; returns the position at its end and the text before it.
    async fn type_line(&self, t: Typed) -> (DocId, Pos, String) {
        let (doc, text) = self.doc(t.file).await;
        let (line, content) = find_line(&text, t.after, t.file);
        let line_start: usize = text.lines().take(line as usize).map(|l| l.len() + 1).sum();
        let end = utf16_len(&text[..line_start + content.len()]);
        self.replace(doc, end, end, &format!("\n{}", t.text)).await;
        let col = utf16_len(t.text);
        (doc, Pos::new(line + 1, col), text)
    }

    async fn replace(&self, doc: DocId, from: u32, to: u32, insert: &str) {
        let version = ops::doc::snapshot(&self.host, WINDOW, doc).await.unwrap().version;
        let changes = ChangeSet { changes: vec![TextChange { from, to, insert: insert.into() }] };
        ops::doc::edit(&self.host, WINDOW, doc, version, changes).unwrap();
    }

    async fn restore(&self, doc: DocId, text: &str) {
        let current = ops::doc::snapshot(&self.host, WINDOW, doc).await.unwrap().text;
        self.replace(doc, 0, utf16_len(&current), text).await;
    }

    fn path(&self, file: &str) -> PathBuf {
        self.root.join(file)
    }

    fn files<P: AsRef<Path>>(&self, paths: impl IntoIterator<Item = P>) -> BTreeSet<String> {
        paths
            .into_iter()
            .filter_map(|p| {
                let p = p.as_ref().strip_prefix(&self.root).ok()?;
                Some(p.to_string_lossy().replace('\\', "/"))
            })
            .collect()
    }

    async fn definition(&self, from: At, to: At) {
        let (doc, pos) = self.locate(from).await;
        let (_, target) = self.locate(to).await;
        let want = self.path(to.file);
        self.retry("go to definition", self.warm_up, || async {
            let found = ops::lsp::lsp_goto(&self.host, WINDOW, doc, pos, GotoKind::Definition).await;
            match &found {
                Ok(locs) if locs.iter().any(|l| *l.path == *want && l.range.start.line == target.line) => Ok(()),
                _ => Err(found),
            }
        })
        .await;
    }

    async fn references(&self, of: At, files: &[&str]) {
        let (doc, pos) = self.locate(of).await;
        let want: BTreeSet<String> = files.iter().map(|f| f.to_string()).collect();
        self.retry("find usages", self.warm_up, || async {
            let found = ops::lsp::lsp_references(&self.host, WINDOW, RequestId(1), doc, pos, true, true).await;
            match &found {
                Ok(r) if want.is_subset(&self.files(r.locations.iter().map(|l| l.path.clone()))) => Ok(()),
                _ => Err(found.map(|r| self.files(r.locations.into_iter().map(|l| l.path)))),
            }
        })
        .await;
    }

    async fn hover(&self, over: At, shows: &str) {
        let (doc, pos) = self.locate(over).await;
        self.retry("hover", self.warm_up, || async {
            let found = ops::lsp::lsp_hover(&self.host, WINDOW, RequestId(2), doc, pos).await;
            match &found {
                Ok(Some(h)) if h.contents.value.contains(shows) => Ok(()),
                _ => Err(found.map(|h| h.map(|h| h.contents.value))),
            }
        })
        .await;
    }

    async fn completion(&self, line: Typed, offers: &str) {
        let (doc, pos, before) = self.type_line(line).await;
        let trigger = line.text.ends_with('.').then(|| ".".to_string());
        self.retry("completion", self.warm_up, || async {
            let found = ops::lsp::lsp_completion(&self.host, WINDOW, RequestId(3), doc, pos, trigger.clone()).await;
            match &found {
                Ok(list)
                    if list.items.iter().any(|i| i.label == offers || i.filter_text.as_deref() == Some(offers)) =>
                {
                    Ok(())
                }
                _ => Err(found.map(|l| l.items.into_iter().take(30).map(|i| i.label).collect::<Vec<_>>())),
            }
        })
        .await;
        self.restore(doc, &before).await;
    }

    async fn diagnostic(&self, file: &str, message: &str) -> Range {
        let path = self.path(file);
        self.retry("diagnostics", self.warm_up, || async {
            let events = self.events.lock().unwrap();
            let latest = events.iter().rev().filter_map(|e| match e {
                IdeEvent::Diagnostics { path: p, items, source } if **p == *path => Some((source, items)),
                _ => None,
            });
            let mut seen = Vec::new();
            for (source, items) in latest {
                if let Some(d) = items.iter().find(|d| d.message.contains(message)) {
                    return Ok(d.range);
                }
                seen.push(format!("{source}: {:?}", items.iter().map(|d| &d.message).collect::<Vec<_>>()));
            }
            Err(seen.into_iter().take(4).collect::<Vec<_>>())
        })
        .await
    }

    /// The code actions over `range` (all kinds, as the ⌥⏎ popup asks), the one titled `title`.
    async fn action(&self, check: &str, doc: DocId, range: Range, title: &str) -> ide_lsp::types::CodeAction {
        let action = self
            .retry(check, self.warm_up, || async {
                let found = ops::lsp::lsp_code_actions(&self.host, WINDOW, doc, range, vec![]).await;
                match found.as_ref().ok().and_then(|a| a.iter().find(|a| a.title.contains(title))) {
                    Some(action) => Ok(action.clone()),
                    None => Err(found.map(|a| a.into_iter().map(|a| a.title).collect::<Vec<_>>())),
                }
            })
            .await;
        if action.edit.is_some() || action.command.is_some() {
            return action;
        }
        ops::lsp::lsp_resolve_code_action(&self.host, WINDOW, doc, action)
            .await
            .unwrap_or_else(|e| self.fail(check, format_args!("resolving {title:?}: {e}")))
    }

    async fn quick_fix(&self, fix: QuickFix) {
        let (doc, _, before) = self.type_line(fix.typed).await;
        assert!(!before.contains(fix.result), "{fix:?}: the file already contains the result");
        let range = self.diagnostic(fix.typed.file, fix.diagnostic).await;
        let action = self.action("quick fix", doc, range, fix.title).await;
        ops::lsp::lsp_execute_code_action(&self.host, WINDOW, RequestId(4), doc, action, vec![])
            .await
            .unwrap_or_else(|e| self.fail("quick fix", format_args!("applying {:?}: {e}", fix.title)));
        self.retry("quick fix", Duration::from_secs(10), || async {
            let text = self.doc(fix.typed.file).await.1;
            if text.contains(fix.result) { Ok(()) } else { Err(text) }
        })
        .await;
        self.restore(doc, &before).await;
    }

    async fn intention(&self, on: At, title: &str) {
        let (doc, range) = self.word_range(on).await;
        let action = self.action("intention", doc, range, title).await;
        let edits = action.edit.as_ref().is_some_and(|e| !e.files.is_empty());
        if !edits && action.command.is_none() {
            self.fail("intention", format_args!("{title:?} has neither an edit nor a command: {action:?}"));
        }
    }

    async fn format(&self, line: Typed, indent: Indent, formatted: &str) {
        let (doc, _, before) = self.type_line(line).await;
        assert!(!before.lines().any(|l| l == formatted), "{line:?}: the file already has {formatted:?}");
        let (tab_size, insert_spaces) = match indent {
            Indent::Spaces(n) => (n, true),
            Indent::Tabs => (4, false),
        };
        let options = FormatOptions { tab_size, insert_spaces, on_save: false, tool: None };
        let text = self
            .retry("format", self.warm_up, || async {
                let edits = ops::lsp::lsp_format(&self.host, WINDOW, doc, None, options.clone()).await;
                let text = self.doc(line.file).await.1;
                let mut document = ide_text::Document::new(&text);
                match &edits {
                    Ok(edits) if !edits.is_empty() && document.apply_edits(edits).is_ok() => Ok(document.text()),
                    _ => Err(edits),
                }
            })
            .await;
        if !text.lines().any(|l| l == formatted) {
            self.fail("format", format_args!("no line {formatted:?} in:\n{text}"));
        }
        self.restore(doc, &before).await;
    }

    async fn rename(&self, symbol: At, to: &str, files: &[&str]) {
        let (doc, pos) = self.locate(symbol).await;
        let prepared = ops::lsp::lsp_prepare_rename(&self.host, WINDOW, doc, pos).await;
        if !matches!(prepared, Ok(Some(_))) {
            self.fail("rename", format_args!("prepare rename: {prepared:?}"));
        }
        let renamed = ops::lsp::lsp_rename(&self.host, WINDOW, RequestId(5), doc, pos, to.into())
            .await
            .unwrap_or_else(|e| self.fail("rename", e));
        let edited = self.files(renamed.edit.files.iter().filter_map(|f| match f {
            ide_core::FileEdit::Edit { path, .. } => Some(path.clone()),
            _ => None,
        }));
        let want: BTreeSet<String> = files.iter().map(|f| f.to_string()).collect();
        if !want.is_subset(&edited) {
            self.fail("rename", format_args!("edits {edited:?}, expected at least {want:?}: {:?}", renamed.edit));
        }
        let mut before = Vec::new();
        for file in files {
            before.push(self.doc(file).await.1.matches(to).count());
        }
        ops::lsp::apply_workspace_edit(&self.host, WINDOW, renamed.edit)
            .await
            .unwrap_or_else(|e| self.fail("rename", format_args!("applying the edit: {e}")));
        for (file, before) in files.iter().zip(before) {
            if self.doc(file).await.1.matches(to).count() <= before {
                self.fail("rename", format_args!("{file} has no new {to:?} after the rename"));
            }
        }
    }

    async fn signature(&self, call: Typed, parameter: &str) {
        let (doc, pos, before) = self.type_line(call).await;
        self.retry("parameter info", self.warm_up, || async {
            let found = ops::lsp::lsp_signature_help(&self.host, WINDOW, doc, pos).await;
            match &found {
                Ok(Some(h)) if h.signatures.iter().any(|s| s.label.contains(parameter)) => Ok(()),
                _ => Err(found.map(|h| h.map(|h| h.signatures.into_iter().map(|s| s.label).collect::<Vec<_>>()))),
            }
        })
        .await;
        self.restore(doc, &before).await;
    }

    async fn outline(&self, file: &str, symbols: &[&str]) {
        let (doc, _) = self.doc(file).await;
        fn names(items: &[ide_core::OutlineItem], out: &mut BTreeSet<String>) {
            for item in items {
                out.insert(item.name.clone());
                names(&item.children, out);
            }
        }
        self.retry("structure", self.warm_up, || async {
            let found = ops::doc::doc_outline(&self.host, WINDOW, doc).await;
            let mut shown = BTreeSet::new();
            if let Ok(items) = &found {
                names(items, &mut shown);
            }
            if symbols.iter().all(|s| shown.contains(*s)) { Ok(()) } else { Err(shown) }
        })
        .await;
    }

    async fn auto_import(&self, a: AutoImport) {
        let (doc, pos, before) = self.type_line(a.typed).await;
        assert!(!before.contains(a.result), "{a:?}: the file already contains the result");
        self.retry("auto-import completion", self.warm_up, || async {
            let list = ops::lsp::lsp_completion(&self.host, WINDOW, RequestId(6), doc, pos, None).await;
            let items = match &list {
                Ok(l) => l.items.iter().filter(|i| i.label == a.label).cloned().collect::<Vec<_>>(),
                Err(e) => return Err(format!("{e}")),
            };
            let text = self.doc(a.typed.file).await.1;
            let mut imports = Vec::new();
            for item in items {
                // Servers compute the import when the item is resolved (on selection).
                let item = if item.additional_edits.is_empty() {
                    ops::lsp::lsp_resolve_completion(&self.host, WINDOW, doc, item.clone()).await.unwrap_or(item)
                } else {
                    item
                };
                let mut document = ide_text::Document::new(&text);
                if document.apply_edits(&item.additional_edits).is_ok() && document.text().contains(a.result) {
                    return Ok(());
                }
                // Or accepting it runs a server command that edits the file (kotlin-lsp).
                if let Some(command) = item.command.clone() {
                    let ran = ops::lsp::lsp_execute_command(&self.host, WINDOW, doc, command).await;
                    let text = self.doc(a.typed.file).await.1;
                    if ran.is_ok() && text.contains(a.result) {
                        return Ok(());
                    }
                }
                imports.push(format!("{:?} {:?}", item.additional_edits, item.command));
            }
            let labels: Vec<String> = list.map(|l| l.items.into_iter().take(20).map(|i| i.label).collect()).unwrap();
            Err(format!("{:?} items' imports: {imports:?}; items: {labels:?}", a.label))
        })
        .await;
        self.restore(doc, &before).await;
    }

    async fn organize_imports(&self, import: Typed, expect: Imports) {
        let (doc, _, before) = self.type_line(import).await;
        let typed = import.text.trim();
        let organized = |text: &str| match expect {
            Imports::Removed => !text.lines().any(|l| l.trim() == typed),
            Imports::Before(line) => {
                let at = |needle: &str| text.lines().position(|l| l.trim() == needle);
                matches!((at(typed), at(line)), (Some(a), Some(b)) if a < b)
            }
        };
        self.retry("optimize imports", self.warm_up, || async {
            let text = self.doc(import.file).await.1;
            // The whole file, as Optimize Imports asks (positions past the end fail on jdtls).
            let last = text.split('\n').count() as u32 - 1;
            let whole = Range::new(Pos::new(0, 0), Pos::new(last, utf16_len(text.rsplit('\n').next().unwrap_or(""))));
            let kind = "source.organizeImports".to_string();
            let found = ops::lsp::lsp_code_actions(&self.host, WINDOW, doc, whole, vec![kind.clone()]).await;
            let actions: Vec<_> = match &found {
                Ok(a) => a.iter().filter(|a| a.kind.as_ref().is_some_and(|k| k.starts_with(&kind))).cloned().collect(),
                Err(e) => return Err(format!("{e}")),
            };
            let Some(action) = actions.iter().find(|a| a.is_preferred).or(actions.first()).cloned() else {
                return Err(format!(
                    "no {kind} action: {:?}",
                    found.map(|a| a.into_iter().map(|a| a.title).collect::<Vec<_>>())
                ));
            };
            ops::lsp::lsp_apply_code_action(&self.host, WINDOW, doc, action).await.map_err(|e| e.to_string())?;
            let text = self.doc(import.file).await.1;
            if organized(&text) { Ok(()) } else { Err(text) }
        })
        .await;
        self.restore(doc, &before).await;
    }

    async fn file_move(&self, from: &str, to: &str, referencing: &str, result: &str) {
        // The servers know the referencing file (opened, as in an editor).
        let _ = self.doc(referencing).await;
        let moves = vec![ide_workspace::FileMove { from: self.path(from).into(), to: self.path(to).into() }];
        let edit = self
            .retry("move file", self.warm_up, || async {
                let found =
                    ops::refactor::refactor_file_move_edits(&self.host, WINDOW, RequestId(7), moves.clone()).await;
                let want = self.path(referencing);
                match &found {
                    Ok(e)
                        if e.edit
                            .files
                            .iter()
                            .any(|f| matches!(f, ide_core::FileEdit::Edit { path, .. } if **path == *want)) =>
                    {
                        Ok(e.edit.clone())
                    }
                    _ => Err(found),
                }
            })
            .await;
        ops::refactor::refactor_move_files(&self.host, WINDOW, moves, edit, "Move".into())
            .await
            .unwrap_or_else(|e| self.fail("move file", e));
        if !self.path(to).is_file() {
            self.fail("move file", format_args!("{to} doesn't exist after the move"));
        }
        let text = self.doc(referencing).await.1;
        if !text.contains(result) {
            self.fail("move file", format_args!("{referencing} has no {result:?} after the move:\n{text}"));
        }
    }

    async fn run(&self, c: &Checks) {
        self.definition(c.definition.0, c.definition.1).await;
        self.references(c.references.0, c.references.1).await;
        self.hover(c.hover.0, c.hover.1).await;
        self.completion(c.completion.0, c.completion.1).await;
        if let Some((file, message)) = c.diagnostic {
            // Opened, as in an editor: servers report the files they have open.
            let _ = self.doc(file).await;
            self.diagnostic(file, message).await;
        }
        if let Some(fix) = c.quick_fix {
            self.quick_fix(fix).await;
        }
        if let Some((on, title)) = c.intention {
            self.intention(on, title).await;
        }
        self.format(c.format.0, c.indent, c.format.1).await;
        self.signature(c.signature.0, c.signature.1).await;
        self.outline(c.outline.0, c.outline.1).await;
        self.auto_import(c.auto_import).await;
        if let Some((import, expect)) = c.organize_imports {
            self.organize_imports(import, expect).await;
        }
        if let Some((symbol, to, files)) = c.rename {
            self.rename(symbol, to, files).await;
        }
        // Last: it moves a file the other checks use.
        if let Some((from, to, referencing, result)) = c.file_move {
            self.file_move(from, to, referencing, result).await;
        }
        let shutdown = self.host.project(WINDOW).unwrap().lsp.clone();
        let _ = tokio::time::timeout(Duration::from_secs(20), shutdown.shutdown_all()).await;
    }
}

async fn smoke(language: &'static str, checks: Checks) {
    let smoke = Smoke::start(language, &checks).await;
    smoke.run(&checks).await;
}

const TYPESCRIPT: Checks = Checks {
    fixture: "ts-app",
    files: &[],
    warm_up: Duration::from_secs(120),
    definition: (
        at("src/index.ts", "Total: ${formatMoney(total)}", "formatMoney"),
        at("src/money.ts", "export function formatMoney", "formatMoney"),
    ),
    references: (at("src/money.ts", "export function formatMoney", "formatMoney"), &["src/index.ts", "src/money.ts"]),
    hover: (at("src/index.ts", "price: cents(8999)", "cents"), "cents(value: number): Cents"),
    completion: (typed("src/index.ts", "const total = cart.total();", "  cart."), "applyDiscount"),
    diagnostic: None,
    quick_fix: Some(QuickFix {
        typed: typed("src/index.ts", "const total = cart.total();", "  console.log(addMoney(total, total));"),
        diagnostic: "Cannot find name 'addMoney'",
        title: "import from \"./money.ts\"",
        result: "import { addMoney, cents, formatMoney } from \"./money.ts\";",
    }),
    intention: Some((at("src/index.ts", "const total = cart.total();", "cart.total()"), "Extract to constant")),
    format: (
        typed("src/index.ts", "const total = cart.total();", "  const  shown={total,count:cart.count}"),
        "  const shown = { total, count: cart.count }",
    ),
    indent: Indent::Spaces(2),
    rename: Some((
        // From a usage in another file: the declaration is renamed too, not aliased in the import.
        at("src/index.ts", "Total: ${formatMoney(total)}", "formatMoney"),
        "formatPrice",
        &["src/index.ts", "src/money.ts"],
    )),
    signature: (typed("src/index.ts", "const total = cart.total();", "  cart.add("), "product"),
    outline: ("src/cart.ts", &["Cart", "add", "total"]),
    auto_import: AutoImport {
        typed: typed("src/index.ts", "const total = cart.total();", "  addMon"),
        label: "addMoney",
        result: "addMoney",
    },
    organize_imports: Some((
        typed(
            "src/index.ts",
            "import { cents, formatMoney } from \"./money.ts\";",
            "import { readFileSync } from \"node:fs\";",
        ),
        Imports::Removed,
    )),
    file_move: Some(("src/money.ts", "src/lib/money.ts", "src/index.ts", "\"./lib/money.ts\"")),
};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "language smoke: needs vtsls"]
async fn typescript() {
    smoke("typescript", TYPESCRIPT).await;
}

const PYTHON: Checks = Checks {
    fixture: "python-app",
    // Ruff (lint, quick fixes, formatting) starts in projects configured for it.
    files: &[("ruff.toml", "")],
    warm_up: Duration::from_secs(120),
    definition: (
        at("src/tasks/cli.py", "tasks = TaskList()", "TaskList"),
        at("src/tasks/models.py", "class TaskList:", "TaskList"),
    ),
    references: (
        at("src/tasks/models.py", "class TaskList:", "TaskList"),
        &["src/tasks/cli.py", "src/tasks/models.py"],
    ),
    hover: (at("src/tasks/cli.py", "tasks.add(\"Write release notes\"", "add"), "def add("),
    completion: (typed("src/tasks/cli.py", "tasks = build_demo()", "    tasks."), "pending"),
    diagnostic: None,
    quick_fix: Some(QuickFix {
        typed: typed("src/tasks/cli.py", "tasks = build_demo()", "    print(Task)"),
        diagnostic: "\"Task\" is not defined",
        title: "from .models import Task",
        result: "from .models import Priority, Task, TaskList",
    }),
    // basedpyright has no refactorings; Ruff's fixes are the Python intentions.
    intention: Some((at("src/tasks/models.py", "import os", "os"), "Remove unused import")),
    format: (
        typed("src/tasks/cli.py", "tasks = build_demo()", "    shown2 = {'a':1,'b':  2}"),
        "    shown2 = {\"a\": 1, \"b\": 2}",
    ),
    indent: Indent::Spaces(4),
    rename: Some((
        at("src/tasks/models.py", "class TaskList:", "TaskList"),
        "TaskBoard",
        &["src/tasks/cli.py", "src/tasks/models.py"],
    )),
    signature: (typed("src/tasks/cli.py", "tasks = build_demo()", "    tasks.add("), "title"),
    outline: ("src/tasks/models.py", &["Priority", "Task", "TaskList", "pending"]),
    auto_import: AutoImport {
        typed: typed("src/tasks/cli.py", "tasks = build_demo()", "    stamp = datetim"),
        label: "datetime",
        result: "import datetime",
    },
    organize_imports: Some((
        typed("src/tasks/models.py", "from enum import IntEnum", "import abc"),
        Imports::Before("import os"),
    )),
    // basedpyright has no `workspace/willRenameFiles`.
    file_move: None,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "language smoke: needs basedpyright and ruff"]
async fn python() {
    smoke("python", PYTHON).await;
}

const RUST: Checks = Checks {
    fixture: "rust-app",
    files: &[],
    warm_up: Duration::from_secs(180),
    definition: (
        at("src/main.rs", "match parser::parse(SAMPLE)", "parse"),
        at("src/parser.rs", "pub fn parse(text: &str)", "parse"),
    ),
    references: (at("src/parser.rs", "pub fn parse(text: &str)", "parse"), &["src/main.rs", "src/parser.rs"]),
    hover: (at("src/main.rs", "inventory.take(&Sku", "take"), "pub fn take("),
    completion: (typed("src/main.rs", "let mut inventory = Inventory::new();", "    inventory."), "low_stock"),
    diagnostic: None,
    quick_fix: Some(QuickFix {
        // rust-analyzer's own analysis, pulled as the file changes (no save, no `cargo check`).
        typed: typed(
            "src/main.rs",
            "let mut inventory = Inventory::new();",
            "    let _blank = parser::ParseError { line: 1 };",
        ),
        diagnostic: "missing structure fields",
        title: "Fill struct fields",
        result: "ParseError { line: 1, message",
    }),
    intention: Some((
        at("src/main.rs", "match parser::parse(SAMPLE)", "parser::parse(SAMPLE)"),
        "Extract into variable",
    )),
    format: (
        typed("src/main.rs", "let mut inventory = Inventory::new();", "    let  _spaced=( 1,2 );"),
        "    let _spaced = (1, 2);",
    ),
    indent: Indent::Spaces(4),
    rename: Some((
        at("src/parser.rs", "pub fn parse(text: &str)", "parse"),
        "parse_all",
        &["src/main.rs", "src/parser.rs"],
    )),
    signature: (typed("src/main.rs", "let mut inventory = Inventory::new();", "    inventory.take("), "sku"),
    outline: ("src/lib.rs", &["Inventory", "Item", "take"]),
    auto_import: AutoImport {
        typed: typed("src/main.rs", "let mut inventory = Inventory::new();", "    let _seen = HashSe"),
        label: "HashSet",
        result: "use std::collections::HashSet;",
    },
    // rust-analyzer has no `source.organizeImports`.
    organize_imports: None,
    file_move: Some(("src/parser.rs", "src/csv.rs", "src/lib.rs", "pub mod csv;")),
};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "language smoke: needs rust-analyzer"]
async fn rust() {
    smoke("rust", RUST).await;
}

const GO: Checks = Checks {
    fixture: "go-app",
    files: &[],
    warm_up: Duration::from_secs(180),
    definition: (
        at("cmd/server/main.go", "s := store.New()", "New"),
        at("internal/store/store.go", "func New() *Store", "New"),
    ),
    references: (
        at("internal/store/store.go", "func New() *Store", "New"),
        &["cmd/server/main.go", "internal/store/store.go"],
    ),
    hover: (
        at("cmd/server/main.go", "writeJSON(w, s.Search(", "Search"),
        "func (s *store.Store) Search(q string) []store.Note",
    ),
    completion: (typed("cmd/server/main.go", "s := store.New()", "\ts."), "Create"),
    diagnostic: None,
    quick_fix: Some(QuickFix {
        typed: typed("cmd/server/main.go", "s := store.New()", "\tfmt.Println(s)"),
        diagnostic: "undefined: fmt",
        title: "\"fmt\"",
        result: "\t\"fmt\"",
    }),
    intention: Some((at("cmd/server/main.go", "s := store.New()", "store.New()"), "Extract")),
    format: (typed("cmd/server/main.go", "s := store.New()", "\t_ =  []int{1,2}"), "\t_ = []int{1, 2}"),
    indent: Indent::Tabs,
    rename: Some((
        at("internal/store/store.go", "func New() *Store", "New"),
        "Open",
        &["cmd/server/main.go", "internal/store/store.go"],
    )),
    signature: (typed("cmd/server/main.go", "s := store.New()", "\ts.Create("), "title"),
    outline: ("internal/store/store.go", &["Store", "New", "(*Store).Create"]),
    auto_import: AutoImport {
        typed: typed("cmd/server/main.go", "s := store.New()", "\t_ = strings.ToUpp"),
        label: "ToUpper",
        result: "\t\"strings\"",
    },
    organize_imports: Some((typed("cmd/server/main.go", "\"strconv\"", "\t\"sort\""), Imports::Removed)),
    // gopls renames packages, not files: moving a Go file changes no references.
    file_move: None,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "language smoke: needs gopls"]
async fn go() {
    smoke("go", GO).await;
}

const JAVA: Checks = Checks {
    fixture: "java-app",
    files: &[],
    warm_up: Duration::from_secs(300),
    definition: (
        at("src/main/java/com/example/orders/App.java", "book.place(\"alice\", \"Mechanical", "place"),
        at("src/main/java/com/example/orders/OrderBook.java", "public Order place(", "place"),
    ),
    references: (
        at("src/main/java/com/example/orders/OrderBook.java", "public Order place(", "place"),
        &["src/main/java/com/example/orders/App.java", "src/test/java/com/example/orders/OrderBookTest.java"],
    ),
    hover: (
        at("src/main/java/com/example/orders/App.java", "long revenue = book.revenueCents()", "revenueCents"),
        "long com.example.orders.OrderBook.revenueCents()",
    ),
    completion: (
        typed("src/main/java/com/example/orders/App.java", "long revenue = book.revenueCents();", "        book."),
        "largest",
    ),
    diagnostic: None,
    quick_fix: Some(QuickFix {
        typed: typed(
            "src/main/java/com/example/orders/App.java",
            "long revenue = book.revenueCents();",
            "        List<Order> all = book.byCustomer(\"alice\");",
        ),
        diagnostic: "List cannot be resolved to a type",
        title: "Import 'List' (java.util)",
        result: "import java.util.List;",
    }),
    intention: Some((
        at("src/main/java/com/example/orders/App.java", "long revenue = book.revenueCents();", "book.revenueCents()"),
        "Extract to local variable",
    )),
    format: (
        typed(
            "src/main/java/com/example/orders/App.java",
            "long revenue = book.revenueCents();",
            "        long  doubled=revenue*2;",
        ),
        "        long doubled = revenue * 2;",
    ),
    indent: Indent::Spaces(4),
    rename: Some((
        at("src/main/java/com/example/orders/OrderBook.java", "public Order place(", "place"),
        "submit",
        &["src/main/java/com/example/orders/App.java", "src/main/java/com/example/orders/OrderBook.java"],
    )),
    signature: (
        typed(
            "src/main/java/com/example/orders/App.java",
            "long revenue = book.revenueCents();",
            "        book.place(",
        ),
        "customer",
    ),
    outline: (
        "src/main/java/com/example/orders/OrderBook.java",
        &["OrderBook", "place(String, String, int, long)", "revenueCents()"],
    ),
    auto_import: AutoImport {
        typed: typed(
            "src/main/java/com/example/orders/App.java",
            "long revenue = book.revenueCents();",
            "        ArrayLis",
        ),
        label: "ArrayList",
        result: "import java.util.ArrayList;",
    },
    organize_imports: Some((
        typed("src/main/java/com/example/orders/OrderBook.java", "import java.util.Optional;", "import java.util.Map;"),
        Imports::Removed,
    )),
    file_move: Some((
        "src/main/java/com/example/orders/OrderBook.java",
        "src/main/java/com/example/orders/Ledger.java",
        "src/main/java/com/example/orders/App.java",
        "Ledger book",
    )),
};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "language smoke: needs jdtls and JDK 21"]
async fn java() {
    smoke("java", JAVA).await;
}

const KOTLIN: Checks = Checks {
    fixture: "kotlin-gradle",
    files: &[],
    warm_up: Duration::from_secs(420),
    definition: (
        at("src/main/kotlin/com/example/library/App.kt", "val library = Library()", "Library"),
        at("src/main/kotlin/com/example/library/Library.kt", "class Library(", "Library"),
    ),
    references: (
        at("src/main/kotlin/com/example/library/Library.kt", "fun search(query: String)", "search"),
        &["src/main/kotlin/com/example/library/App.kt", "src/main/kotlin/com/example/library/Library.kt"],
    ),
    hover: (
        at("src/main/kotlin/com/example/library/App.kt", "library.search(\"java\")", "search"),
        "fun search(query: String): List<Book>",
    ),
    completion: (
        typed("src/main/kotlin/com/example/library/App.kt", "val library = Library()", "    library."),
        "lend",
    ),
    diagnostic: None,
    quick_fix: Some(QuickFix {
        typed: typed(
            "src/main/kotlin/com/example/library/App.kt",
            "val library = Library()",
            "    val stamp = LocalDateTime.now()",
        ),
        diagnostic: "Unresolved reference",
        title: "Import",
        result: "import java.time.LocalDateTime",
    }),
    intention: Some((
        at("src/main/kotlin/com/example/library/Library.kt", "fun giveBack(isbn: String): Boolean", "giveBack"),
        "block body",
    )),
    format: (
        typed("src/main/kotlin/com/example/library/App.kt", "val library = Library()", "    val  pair=listOf(1,2)"),
        "    val pair = listOf(1, 2)",
    ),
    indent: Indent::Spaces(4),
    rename: Some((
        at("src/main/kotlin/com/example/library/Library.kt", "fun search(query: String)", "search"),
        "find",
        &["src/main/kotlin/com/example/library/App.kt", "src/main/kotlin/com/example/library/Library.kt"],
    )),
    signature: (
        typed("src/main/kotlin/com/example/library/App.kt", "val library = Library()", "    library.lend("),
        "isbn",
    ),
    outline: ("src/main/kotlin/com/example/library/Library.kt", &["Library", "lend", "search"]),
    auto_import: AutoImport {
        typed: typed(
            "src/main/kotlin/com/example/library/App.kt",
            "val library = Library()",
            "    val stamp = LocalDateTi",
        ),
        label: "LocalDateTime",
        result: "import java.time.LocalDateTime",
    },
    organize_imports: Some((
        typed("src/main/kotlin/com/example/library/App.kt", "import java.time.LocalDate", "import java.util.UUID"),
        Imports::Removed,
    )),
    // kotlin-lsp has no `workspace/willRenameFiles`.
    file_move: None,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "language smoke: needs kotlin-lsp, a JDK and Gradle"]
async fn kotlin() {
    smoke("kotlin", KOTLIN).await;
}

/// Intelephense without a licence key: the baseline the native PHP engine has to match
/// (`docs/php-engine/ROADMAP.md`).
const PHP: Checks = Checks {
    fixture: "php-app",
    files: &[],
    warm_up: Duration::from_secs(120),
    definition: (
        at("bin/library.php", "slugify($lent->title)", "slugify"),
        at("src/functions.php", "function slugify(string $text)", "slugify"),
    ),
    references: (
        at("src/functions.php", "function format_price(", "format_price"),
        &["src/Library.php", "src/Reports/ShelfReport.php", "src/functions.php"],
    ),
    hover: (at("src/Library.php", "return format_price($cents);", "format_price"), "format_price(int $cents"),
    completion: (typed("src/Library.php", "$lent = $book->withAvailability(false);", "        $lent->"), "label"),
    // The fixture's deliberate error.
    diagnostic: Some(("src/Reports/ShelfReport.php", "Undefined method 'count'")),
    // Code actions (quick fixes, intentions, Optimize Imports), rename and file moves are
    // Intelephense Premium features.
    quick_fix: None,
    intention: None,
    format: (
        typed("src/Library.php", "$lent = $book->withAvailability(false);", "        $shown=[1,2];"),
        "        $shown = [1, 2];",
    ),
    indent: Indent::Spaces(4),
    // Without a licence Intelephense doesn't offer rename ("intelephense doesn't support rename").
    rename: None,
    signature: (
        typed("src/Library.php", "$lent = $book->withAvailability(false);", "        $this->checkout("),
        "$isbn",
    ),
    outline: ("src/Library.php", &["Library", "add", "checkout", "available"]),
    auto_import: AutoImport {
        typed: typed("src/Library.php", "$lent = $book->withAvailability(false);", "        $genre = Genr"),
        label: "Genre",
        result: "use App\\Model\\Genre;",
    },
    organize_imports: None,
    file_move: None,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "language smoke: needs intelephense"]
async fn php() {
    smoke("php", PHP).await;
}
