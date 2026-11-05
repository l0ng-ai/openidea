//! Saved PHP files -> `vendor/bin/phpstan analyse` -> `phpstan` diagnostics.

use ide_core::event::NotifyLevel;
use ide_core::output_encoding::decode_tool_output;
use ide_core::{CancellationToken, Diagnostic, IdeEvent, Pos, Range, Severity, SharedSink};
use ide_workspace::SettingsStore;
use ide_workspace::documents::DocumentObserver;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tokio::sync::Notify;

const DELAY: Duration = Duration::from_millis(750);
const SOURCE: &str = "phpstan";

/// Saved files waiting for a check. Each save cancels the wait or the check in progress.
#[derive(Default)]
struct Queue {
    generation: u64,
    cancel: CancellationToken,
    files: BTreeSet<PathBuf>,
}

impl Queue {
    fn push(&mut self, files: impl IntoIterator<Item = PathBuf>) {
        self.files.extend(files);
        self.cancel.cancel();
        self.generation += 1;
        self.cancel = CancellationToken::new();
    }
    fn current(&self, generation: u64) -> bool {
        self.generation == generation && !self.cancel.is_cancelled()
    }
}

pub(crate) struct Phpstan {
    root: PathBuf,
    config_dir: PathBuf,
    settings: Arc<SettingsStore>,
    sink: SharedSink,
    trusted: Arc<AtomicBool>,
    lifetime: CancellationToken,
    queue: Mutex<Queue>,
    changed: Notify,
    /// Files with PHPStan diagnostics, the only ones a clean result or a removal clears.
    shown: Mutex<HashSet<PathBuf>>,
}

impl Phpstan {
    pub(crate) fn new(
        root: PathBuf,
        config_dir: PathBuf,
        settings: Arc<SettingsStore>,
        sink: SharedSink,
        trusted: Arc<AtomicBool>,
    ) -> Arc<Self> {
        Arc::new(Self {
            root,
            config_dir,
            settings,
            sink,
            trusted,
            lifetime: CancellationToken::new(),
            queue: Mutex::new(Queue::default()),
            changed: Notify::new(),
            shown: Mutex::new(HashSet::new()),
        })
    }

    pub(crate) fn start(self: &Arc<Self>, runtime: &tokio::runtime::Handle) {
        let checker = self.clone();
        runtime.spawn(async move { checker.run().await });
    }

    pub(crate) fn stop(&self) {
        self.lifetime.cancel();
        self.queue.lock().cancel.cancel();
    }

    /// Stops the check in progress (trust changed); its files wait for the next one, which drops
    /// them while the project is in Restricted Mode.
    pub(crate) fn interrupt(&self) {
        self.queue.lock().push([]);
        self.changed.notify_one();
    }

    fn files_saved(&self, paths: impl IntoIterator<Item = PathBuf>) {
        let mut files = paths.into_iter().filter(|p| p.extension().is_some_and(|e| e == "php")).peekable();
        if self.lifetime.is_cancelled() || files.peek().is_none() {
            return;
        }
        self.queue.lock().push(files);
        self.changed.notify_one();
    }

    /// Deleted files and folders lose their diagnostics.
    pub(crate) fn files_removed<'a>(&self, removed: impl Iterator<Item = &'a PathBuf>) {
        let removed: Vec<&PathBuf> = removed.collect();
        let gone: Vec<PathBuf> =
            self.shown.lock().iter().filter(|p| removed.iter().any(|r| p.starts_with(r))).cloned().collect();
        for path in gone {
            self.publish(path, Vec::new());
        }
    }

    fn publish(&self, path: PathBuf, items: Vec<Diagnostic>) {
        let mut shown = self.shown.lock();
        if items.is_empty() {
            if !shown.remove(&path) {
                return;
            }
        } else {
            shown.insert(path.clone());
        }
        // Under the lock, so a removal and a result for one file reach the UI in the order decided here.
        self.sink.emit(IdeEvent::Diagnostics { path: path.into(), source: SOURCE.into(), items });
    }

    async fn run(self: Arc<Self>) {
        // The failure last reported per root: each is reported once, until a run succeeds.
        let mut failures: BTreeMap<PathBuf, String> = BTreeMap::new();
        loop {
            tokio::select! {
                _ = self.lifetime.cancelled() => return,
                _ = self.changed.notified() => {},
            }
            let (generation, cancel) = {
                let queue = self.queue.lock();
                (queue.generation, queue.cancel.clone())
            };
            if !debounce(&cancel, &self.lifetime).await {
                continue;
            }
            let files = {
                let mut queue = self.queue.lock();
                if !queue.current(generation) {
                    continue;
                }
                std::mem::take(&mut queue.files)
            };
            if !self.trusted.load(Ordering::Acquire) {
                continue;
            }
            let (root, config_dir, settings) = (self.root.clone(), self.config_dir.clone(), self.settings.clone());
            let Ok((checks, unchecked)) =
                tokio::task::spawn_blocking(move || plan(&root, &config_dir, &settings, files)).await
            else {
                continue;
            };
            for path in unchecked {
                self.publish(path, Vec::new());
            }
            let mut checks = checks.into_iter();
            while let Some(check) = checks.next() {
                let started = std::time::Instant::now();
                let program = check.command.get_program().to_string_lossy().into_owned();
                let output = analyse(check.command, &cancel).await;
                let Some(output) = output.filter(|_| self.queue.lock().current(generation)) else {
                    // A newer save: these files are checked again with it.
                    let mut queue = self.queue.lock();
                    queue.files.extend(check.files);
                    queue.files.extend(checks.by_ref().flat_map(|c| c.files));
                    break;
                };
                tracing::debug!(
                    "phpstan checked {} file(s) in {} ms",
                    check.files.len(),
                    started.elapsed().as_millis()
                );
                // Files deleted meanwhile make the result (or the failure) moot: check the rest again.
                let (present, missing): (Vec<PathBuf>, Vec<PathBuf>) =
                    check.files.iter().cloned().partition(|f| f.is_file());
                if !missing.is_empty() {
                    for path in missing {
                        self.publish(path, Vec::new());
                    }
                    self.files_saved(present);
                    continue;
                }
                let report = match output {
                    Ok(output) => {
                        let parsed = parse(&decode_tool_output(&output.stdout), &decode_tool_output(&output.stderr));
                        parsed.map_err(|text| {
                            if text.is_empty() {
                                let status = output.status;
                                format!("PHPStan ended with {status} and no report")
                            } else {
                                text
                            }
                        })
                    }
                    Err(error) => Err(format!("Cannot run {program}: {error}")),
                };
                let failure = match report {
                    Ok(report) => {
                        let files = check.files.clone();
                        let results = tokio::task::spawn_blocking(move || diagnostics(&files, report.files))
                            .await
                            .unwrap_or_default();
                        for (path, items) in results {
                            // Severe errors (a syntax error) stop the analysis of the other files.
                            if report.complete || !items.is_empty() {
                                self.publish(path, items);
                            }
                        }
                        report.errors.join("\n")
                    }
                    Err(text) => {
                        // Without a report the earlier errors of these files may be stale.
                        for path in check.files {
                            self.publish(path, Vec::new());
                        }
                        text
                    }
                };
                if failure.is_empty() {
                    failures.remove(&check.root);
                } else {
                    self.failure(&check.root, failure, &mut failures);
                }
            }
        }
    }

    fn failure(&self, root: &Path, text: String, failures: &mut BTreeMap<PathBuf, String>) {
        if failures.get(root) == Some(&text) {
            return;
        }
        self.sink.emit(IdeEvent::Notify {
            level: NotifyLevel::Error,
            title: "PHPStan check failed".into(),
            body: Some(text.clone()),
        });
        failures.insert(root.to_path_buf(), text);
    }
}

impl DocumentObserver for Phpstan {
    fn saved(&self, _doc: ide_core::DocId, path: &Path, _text: &str) {
        self.files_saved([path.to_path_buf()]);
    }
}

async fn debounce(cancel: &CancellationToken, lifetime: &CancellationToken) -> bool {
    tokio::select! {
        _ = lifetime.cancelled() => false,
        _ = cancel.cancelled() => false,
        _ = tokio::time::sleep(DELAY) => true,
    }
}

/// One `vendor/bin/phpstan` run: the saved files below one PHP project.
struct Check {
    root: PathBuf,
    files: Vec<PathBuf>,
    command: Command,
}

/// The runs that check `files`, and the files not checked, whose earlier diagnostics no longer
/// apply. A file belongs to the innermost linked project (with its own settings) that contains it,
/// else to the project; deleted files, files in `vendor` or in excluded folders, and files of a
/// project without PHPStan are not checked.
fn plan(
    project: &Path,
    config_dir: &Path,
    settings: &SettingsStore,
    files: BTreeSet<PathBuf>,
) -> (Vec<Check>, Vec<PathBuf>) {
    let members =
        ide_workspace::workspace::Workspace::load(project).ok().flatten().map(|w| w.projects).unwrap_or_default();
    let mut groups: BTreeMap<PathBuf, Vec<PathBuf>> = BTreeMap::new();
    let mut unchecked = Vec::new();
    for file in files {
        let member = members.iter().filter(|m| file.starts_with(m)).max_by_key(|m| m.components().count());
        let root = member.cloned().or_else(|| file.starts_with(project).then(|| project.to_path_buf()));
        match root {
            Some(root) if file.is_file() => groups.entry(root).or_default().push(file),
            _ => unchecked.push(file),
        }
    }
    let mut checks = Vec::new();
    for (root, files) in groups {
        let effective = if root == project {
            settings.effective()
        } else {
            SettingsStore::load(config_dir, Some(&root)).effective()
        };
        let excludes = ide_vfs::ExcludeMatcher::new(&effective.exclude_globs());
        let (files, skipped): (Vec<PathBuf>, Vec<PathBuf>) = files.into_iter().partition(|f| {
            f.strip_prefix(&root).is_ok_and(|rel| !rel.starts_with("vendor") && !excludes.is_excluded(rel))
        });
        unchecked.extend(skipped);
        match ide_sdk::php::phpstan_command(&root, &effective, &files).filter(|_| !files.is_empty()) {
            Some(command) => checks.push(Check { root, files, command }),
            None => unchecked.extend(files),
        }
    }
    (checks, unchecked)
}

/// Runs `cmd` to its end; `None` when `cancel` fires first, which kills it.
async fn analyse(mut cmd: Command, cancel: &CancellationToken) -> Option<std::io::Result<Output>> {
    if cancel.is_cancelled() {
        return None;
    }
    ide_core::process::prepare(&mut cmd);
    ide_core::process::own_group(&mut cmd);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut cmd = tokio::process::Command::from(cmd);
    cmd.kill_on_drop(true);
    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => return Some(Err(error)),
    };
    let pid = child.id();
    // PHPStan may start workers of its own.
    let cancelled = async {
        cancel.cancelled().await;
        if let Some(pid) = pid {
            let _ = tokio::task::spawn_blocking(move || ide_core::process::kill_tree_of(pid)).await;
        }
    };
    tokio::select! {
        output = child.wait_with_output() => Some(output),
        () = cancelled => None,
    }
}

/// A PHPStan message: 0-based line, text with its tip, identifier.
#[derive(Debug, PartialEq)]
struct Message {
    line: u32,
    text: String,
    identifier: Option<String>,
}

/// A JSON report: messages per file as PHPStan names it, the errors of the run itself, and
/// whether every file was analysed (severe errors such as a syntax error stop the others).
#[derive(Debug, PartialEq)]
struct Report {
    files: BTreeMap<String, Vec<Message>>,
    errors: Vec<String>,
    complete: bool,
}

impl Default for Report {
    fn default() -> Self {
        Self { files: BTreeMap::new(), errors: Vec::new(), complete: true }
    }
}

/// PHPStan's `--error-format=json` report, or the text to report when there is none (an
/// invalid configuration, a crash). PHP warnings, or a byte order mark a bootstrap file prints,
/// may precede the report on stdout.
fn parse(stdout: &str, stderr: &str) -> Result<Report, String> {
    let json = serde_json::from_str::<Value>(stdout.trim().trim_start_matches('\u{feff}')).ok().or_else(|| {
        stdout.lines().rev().find_map(|l| l.find('{').and_then(|start| serde_json::from_str(&l[start..]).ok()))
    });
    let Some(Value::Object(json)) = json else {
        // Every saved file is excluded by the configuration (`excludePaths`).
        if stderr.contains("No files found to analyse") {
            return Ok(Report::default());
        }
        return Err(failure_text(stdout, stderr));
    };
    let mut report = Report::default();
    if let Some(Value::Object(files)) = json.get("files") {
        for (file, result) in files {
            let messages = result.get("messages").and_then(Value::as_array).into_iter().flatten();
            report.files.insert(file.clone(), messages.filter_map(message).collect());
        }
    }
    let errors = json.get("errors").and_then(Value::as_array).into_iter().flatten();
    report.errors = errors.map(|e| e.as_str().map_or_else(|| e.to_string(), str::to_owned)).collect();
    report.complete = !stderr.contains("Result is incomplete");
    Ok(report)
}

fn message(m: &Value) -> Option<Message> {
    let mut text = m.get("message")?.as_str()?.to_owned();
    if let Some(tip) = m.get("tip").and_then(Value::as_str).filter(|t| !t.trim().is_empty()) {
        text = format!("{text}\n{}", strip_console_tags(tip));
    }
    let line = m.get("line").and_then(Value::as_u64).unwrap_or(1).max(1) - 1;
    Some(Message {
        line: u32::try_from(line).unwrap_or(u32::MAX),
        text,
        identifier: m.get("identifier").and_then(Value::as_str).map(str::to_owned),
    })
}

/// Tips may carry console styling (`<fg=cyan>…</>`).
fn strip_console_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let tag = rest.find('>').map(|end| &rest[..=end]);
        match tag {
            Some(tag)
                if tag == "</>"
                    || tag.starts_with("<fg=")
                    || tag.starts_with("<bg=")
                    || tag.starts_with("<options=") =>
            {
                rest = &rest[tag.len()..];
            }
            _ => {
                out.push('<');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// What PHPStan printed instead of a report, without its notes and blank lines.
fn failure_text(stdout: &str, stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .chain(stdout.lines())
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("Note: Using configuration file"))
        .collect();
    lines.iter().take(20).copied().collect::<Vec<_>>().join("\n")
}

/// The diagnostics of each checked file (none for a clean one), matched to the report's files
/// by their real paths. Errors PHPStan reports in a trait name the class using it
/// (`Trait.php (in context of class Foo)`).
fn diagnostics(files: &[PathBuf], reported: BTreeMap<String, Vec<Message>>) -> Vec<(PathBuf, Vec<Diagnostic>)> {
    let real = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let mut messages: BTreeMap<PathBuf, Vec<Message>> = BTreeMap::new();
    for (name, list) in reported {
        let name = name.split(" (in context of ").next().unwrap_or(&name);
        messages.entry(real(Path::new(name))).or_default().extend(list);
    }
    files
        .iter()
        .map(|file| {
            let list = messages.remove(&real(file)).unwrap_or_default();
            // Columns only: a file in another encoding than UTF-8 still gives the right lines.
            let text = if list.is_empty() {
                None
            } else {
                std::fs::read(file).ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            };
            let items = list.into_iter().map(|m| diagnostic(m, text.as_deref())).collect();
            (file.clone(), items)
        })
        .collect()
}

fn diagnostic(m: Message, text: Option<&str>) -> Diagnostic {
    Diagnostic {
        range: line_range(text, m.line),
        severity: Severity::Warning,
        message: m.text,
        source: Some("PHPStan".into()),
        server: Some(SOURCE.into()),
        code: m.identifier,
        unnecessary: false,
        deprecated: false,
    }
}

/// PHPStan reports lines only: the line from its first non-blank character to its end (UTF-16).
fn line_range(text: Option<&str>, line: u32) -> Range {
    let text = text.map(|t| t.strip_prefix('\u{feff}').unwrap_or(t));
    let content = text.and_then(|t| t.split('\n').nth(line as usize)).unwrap_or("").trim_end();
    let indent = content.len() - content.trim_start().len();
    let col = |s: &str| u32::try_from(s.encode_utf16().count()).unwrap_or(u32::MAX);
    Range { start: Pos { line, col: col(&content[..indent]) }, end: Pos { line, col: col(content) } }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPORT: &str = r#"{"totals":{"errors":0,"file_errors":3},"files":{
        "/p/src/A.php":{"errors":2,"messages":[
            {"message":"Constant UNKNOWN not found.","line":11,"ignorable":true,
             "tip":"Learn more at https://phpstan.org/user-guide/discovering-symbols","identifier":"constant.notFound"},
            {"message":"Access to an undefined property.","line":3,"ignorable":true,
             "tip":"Learn more: <fg=cyan>https://phpstan.org/blog/solving</> for array<int, string>","identifier":"property.notFound"}]},
        "/p/src/T.php (in context of class App\\A)":{"errors":1,"messages":[
            {"message":"Syntax error","line":null,"ignorable":false,"identifier":"phpstan.parse"}]}},
        "errors":[]}"#;

    fn message(line: u32, text: &str, identifier: &str) -> Message {
        Message { line, text: text.into(), identifier: Some(identifier.into()) }
    }

    #[test]
    fn messages_keep_their_line_tip_and_identifier() {
        let report = parse(REPORT, "Note: Using configuration file /p/phpstan.neon.").unwrap();
        assert!(report.errors.is_empty());
        assert_eq!(
            report.files["/p/src/A.php"],
            [
                message(
                    10,
                    "Constant UNKNOWN not found.\nLearn more at https://phpstan.org/user-guide/discovering-symbols",
                    "constant.notFound"
                ),
                message(
                    2,
                    "Access to an undefined property.\nLearn more: https://phpstan.org/blog/solving for array<int, string>",
                    "property.notFound"
                ),
            ]
        );
        assert_eq!(
            report.files["/p/src/T.php (in context of class App\\A)"],
            [message(0, "Syntax error", "phpstan.parse")]
        );
    }

    #[test]
    fn errors_of_the_run_are_not_file_messages() {
        let stdout =
            r#"{"totals":{"errors":1,"file_errors":0},"files":[],"errors":["Invalid entries in excludePaths"]}"#;
        let report = parse(stdout, "").unwrap();
        assert!(report.files.is_empty());
        assert_eq!(report.errors, ["Invalid entries in excludePaths"]);
        // PHP warnings ahead of the report, or a byte order mark printed by a bootstrap file.
        let warned = format!("Deprecated: something in /p/x.php on line 3\n{stdout}");
        assert_eq!(parse(&warned, "").unwrap().errors, ["Invalid entries in excludePaths"]);
        let marked = format!("\u{feff}{stdout}");
        assert_eq!(parse(&marked, "").unwrap().errors, ["Invalid entries in excludePaths"]);
        assert_eq!(parse(&format!("Notice: x{stdout}"), "").unwrap().errors, ["Invalid entries in excludePaths"]);
        assert!(parse(stdout, "").unwrap().complete);
        let severe = " Result is incomplete because of severe errors.";
        assert!(!parse(stdout, severe).unwrap().complete);
    }

    #[test]
    fn output_without_a_report_is_a_failure() {
        let stderr = "Note: Using configuration file /p/phpstan.neon.\n\n  Invalid entry in excludePaths:\n  Path \"/p/nothere\" is neither a directory\n\n";
        assert_eq!(
            parse("", stderr),
            Err("Invalid entry in excludePaths:\nPath \"/p/nothere\" is neither a directory".to_string())
        );
        assert_eq!(
            parse("Fatal error: Allowed memory size exhausted", ""),
            Err("Fatal error: Allowed memory size exhausted".into())
        );
        assert_eq!(parse("", ""), Err(String::new()));
        // Excluded files are no failure: nothing to report.
        assert_eq!(parse("", " [ERROR] No files found to analyse.\n"), Ok(Report::default()));
    }

    #[test]
    fn checked_files_get_their_messages_and_clean_files_none() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let (a, t, clean) = (root.join("A.php"), root.join("T.php"), root.join("Clean.php"));
        std::fs::write(&a, "<?php\n\n    echo $é;  \r\n").unwrap();
        std::fs::write(&t, "<?php\n").unwrap();
        std::fs::write(&clean, "<?php\n").unwrap();
        let reported = BTreeMap::from([
            (a.to_string_lossy().into_owned(), vec![message(2, "Undefined variable", "variable.undefined")]),
            (format!("{} (in context of class A)", t.display()), vec![message(0, "In a trait", "trait.x")]),
            ("/elsewhere/B.php".to_string(), vec![message(0, "Not checked", "x")]),
        ]);
        let out = diagnostics(&[a.clone(), t.clone(), clean.clone()], reported);
        assert_eq!(
            out.iter().map(|(p, items)| (p.clone(), items.len())).collect::<Vec<_>>(),
            [(a, 1), (t, 1), (clean, 0)]
        );
        let d = &out[0].1[0];
        // From the first non-blank character to the end of the line, in UTF-16 columns.
        assert_eq!(d.range, Range { start: Pos { line: 2, col: 4 }, end: Pos { line: 2, col: 12 } });
        assert_eq!(
            (d.code.as_deref(), d.source.as_deref(), d.server.as_deref(), d.severity),
            (Some("variable.undefined"), Some("PHPStan"), Some("phpstan"), Severity::Warning)
        );
        assert_eq!(line_range(None, 7), Range { start: Pos { line: 7, col: 0 }, end: Pos { line: 7, col: 0 } });
    }

    #[tokio::test(start_paused = true)]
    async fn burst_saves_give_one_check_of_all_files() {
        let mut queue = Queue::default();
        queue.push([PathBuf::from("/p/A.php")]);
        let token = queue.cancel.clone();
        let lifetime = CancellationToken::new();
        let pending_lifetime = lifetime.clone();
        let waiting = tokio::spawn(async move { debounce(&token, &pending_lifetime).await });
        tokio::task::yield_now().await;
        tokio::time::advance(DELAY - Duration::from_millis(1)).await;
        assert!(!waiting.is_finished());
        for i in 0..20 {
            queue.push([PathBuf::from(format!("/p/{}.php", i % 3))]);
        }
        assert!(!waiting.await.unwrap());
        let current = queue.generation;
        assert!(debounce(&queue.cancel, &lifetime).await);
        assert!(queue.current(current));
        assert_eq!(queue.files.len(), 4);
        lifetime.cancel();
        assert!(!debounce(&queue.cancel, &lifetime).await);
    }

    /// A project with PHPStan whose PHP logs each run, waits `pause` seconds, prints `stderr` and
    /// reports `report`.
    #[cfg(unix)]
    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        events: Arc<Mutex<Vec<IdeEvent>>>,
        trusted: Arc<AtomicBool>,
        checker: Arc<Phpstan>,
    }

    #[cfg(unix)]
    impl Fixture {
        fn new() -> Self {
            use std::os::unix::fs::PermissionsExt;
            let dir = tempfile::tempdir().unwrap();
            let base = dunce::canonicalize(dir.path()).unwrap();
            let root = base.join("project");
            std::fs::create_dir_all(root.join("vendor/bin")).unwrap();
            std::fs::create_dir_all(root.join("src")).unwrap();
            std::fs::write(root.join("vendor/bin/phpstan"), "<?php\n").unwrap();
            // Named php8.5: the selected PHP runs vendor/bin/phpstan, whatever its name.
            let php = base.join("php/php8.5");
            std::fs::create_dir_all(php.parent().unwrap()).unwrap();
            let script = "#!/bin/sh\nshift\necho \"$XDEBUG_MODE $*\" >> runs.log\n\
                sleep \"$(cat pause 2>/dev/null || echo 0)\"\ncat stderr >&2 2>/dev/null\ncat report\n";
            std::fs::write(&php, script).unwrap();
            std::fs::set_permissions(&php, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::create_dir_all(root.join(".openidea")).unwrap();
            let settings = format!("[languages.php]\ninterpreter = {:?}\n", php.to_string_lossy());
            std::fs::write(root.join(".openidea/settings.toml"), settings).unwrap();
            let config = base.join("config");
            let settings = Arc::new(SettingsStore::load(&config, Some(&root)));
            let events = Arc::new(Mutex::new(Vec::new()));
            let sink_events = events.clone();
            let sink: SharedSink = Arc::new(move |e| sink_events.lock().push(e));
            let trusted = Arc::new(AtomicBool::new(true));
            let checker = Phpstan::new(root.clone(), config, settings, sink, trusted.clone());
            checker.start(&tokio::runtime::Handle::current());
            Self { _dir: dir, root, events, trusted, checker }
        }

        fn file(&self, name: &str) -> PathBuf {
            let path = self.root.join("src").join(name);
            std::fs::write(&path, "<?php\necho UNKNOWN;\n").unwrap();
            path
        }

        fn report(&self, path: &Path, identifiers: &[&str]) {
            let messages: Vec<Value> = identifiers
                .iter()
                .map(|id| serde_json::json!({"message": "Bad", "line": 2, "identifier": id, "ignorable": true}))
                .collect();
            let files = if messages.is_empty() {
                serde_json::json!({})
            } else {
                serde_json::json!({ path.to_string_lossy(): {"errors": messages.len(), "messages": messages} })
            };
            std::fs::write(self.root.join("report"), serde_json::json!({"files": files, "errors": []}).to_string())
                .unwrap();
        }

        fn runs(&self) -> Vec<String> {
            std::fs::read_to_string(self.root.join("runs.log")).unwrap_or_default().lines().map(str::to_owned).collect()
        }

        async fn until(&self, what: &str, done: impl Fn(&Self) -> bool) {
            for _ in 0..200 {
                if done(self) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            panic!("timed out waiting for {what}: runs {:?}, events {:?}", self.runs(), self.events.lock());
        }

        fn diagnostics(&self) -> Vec<(PathBuf, Vec<Option<String>>)> {
            self.events
                .lock()
                .iter()
                .filter_map(|e| match e {
                    IdeEvent::Diagnostics { path, source, items } if source == SOURCE => {
                        Some((path.to_path_buf(), items.iter().map(|d| d.code.clone()).collect()))
                    }
                    _ => None,
                })
                .collect()
        }

        fn notifications(&self) -> Vec<String> {
            let events = self.events.lock();
            events.iter().filter(|e| matches!(e, IdeEvent::Notify { .. })).map(|e| format!("{e:?}")).collect()
        }
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn saves_are_checked_together_and_a_newer_save_cancels_the_check() {
        let f = Fixture::new();
        let a = f.file("A.php");
        f.report(&a, &["constant.notFound"]);
        for _ in 0..5 {
            f.checker.files_saved([a.clone(), f.root.join("src/readme.txt")]);
        }
        f.until("one check", |f| f.diagnostics().len() == 1).await;
        assert_eq!(f.runs(), [format!("off analyse --error-format=json --no-progress {}", a.display())]);
        assert_eq!(f.diagnostics(), [(a.clone(), vec![Some("constant.notFound".to_string())])]);

        // A save during a check kills it; the next check covers both files.
        std::fs::write(f.root.join("pause"), "30").unwrap();
        f.checker.files_saved([a.clone()]);
        f.until("the slow check", |f| f.runs().len() == 2).await;
        std::fs::write(f.root.join("pause"), "0").unwrap();
        let b = f.file("B.php");
        f.report(&a, &[]);
        f.checker.files_saved([b.clone()]);
        f.until("the check of both", |f| f.runs().len() == 3 && f.diagnostics().len() == 2).await;
        assert!(f.runs()[2].ends_with(&format!("{} {}", a.display(), b.display())), "{:?}", f.runs());
        // A clean result clears A; B never had diagnostics, so nothing is sent for it.
        assert_eq!(f.diagnostics()[1], (a, vec![]));
        f.checker.stop();
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failing_run_is_reported_once_and_projects_without_phpstan_stay_quiet() {
        let f = Fixture::new();
        let a = f.file("A.php");
        f.report(&a, &["constant.notFound"]);
        f.checker.files_saved([a.clone()]);
        f.until("the first check", |f| f.diagnostics().len() == 1).await;

        std::fs::write(f.root.join("report"), "").unwrap();
        for run in 2..=3 {
            f.checker.files_saved([a.clone()]);
            f.until("the failing check", |f| f.runs().len() == run).await;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        let notes = f.notifications();
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!(notes[0].contains("PHPStan check failed") && notes[0].contains("no report"), "{notes:?}");
        // The failed check leaves no stale errors.
        assert_eq!(f.diagnostics(), [(a.clone(), vec![Some("constant.notFound".to_string())]), (a.clone(), vec![])]);

        std::fs::remove_file(f.root.join("vendor/bin/phpstan")).unwrap();
        let events = f.events.lock().len();
        f.checker.files_saved([a.clone()]);
        tokio::time::sleep(DELAY * 2).await;
        assert_eq!(f.events.lock().len(), events);
        f.checker.stop();
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn files_a_severe_error_left_unchecked_keep_their_diagnostics() {
        let f = Fixture::new();
        let (a, b) = (f.file("A.php"), f.file("B.php"));
        f.report(&a, &["constant.notFound"]);
        f.checker.files_saved([a.clone()]);
        f.until("the check of A", |f| f.diagnostics().len() == 1).await;
        // A syntax error in B: PHPStan reports B only and says the result is incomplete.
        f.report(&b, &["phpstan.parse"]);
        std::fs::write(f.root.join("stderr"), "Result is incomplete because of severe errors.").unwrap();
        f.checker.files_saved([a.clone(), b.clone()]);
        f.until("the check of both", |f| f.diagnostics().len() == 2).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(f.diagnostics()[1], (b, vec![Some("phpstan.parse".to_string())]));
        assert_eq!(f.diagnostics().len(), 2, "A is not cleared");
        f.checker.stop();
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_file_deleted_during_its_check_gets_no_result_and_no_failure() {
        let f = Fixture::new();
        let (a, b) = (f.file("A.php"), f.file("B.php"));
        f.report(&a, &["constant.notFound"]);
        std::fs::write(f.root.join("pause"), "1").unwrap();
        f.checker.files_saved([a.clone(), b.clone()]);
        f.until("the check", |f| f.runs().len() == 1).await;
        std::fs::remove_file(&a).unwrap();
        // B is checked again on its own.
        f.until("the check of B", |f| f.runs().len() == 2).await;
        assert!(f.runs()[1].ends_with(&format!("--no-progress {}", b.display())), "{:?}", f.runs());
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(f.events.lock().is_empty(), "{:?}", f.events.lock());
        f.checker.stop();
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restricted_mode_stops_the_check_in_progress() {
        let f = Fixture::new();
        let a = f.file("A.php");
        f.report(&a, &["constant.notFound"]);
        std::fs::write(f.root.join("pause"), "30").unwrap();
        f.checker.files_saved([a.clone()]);
        f.until("the check", |f| f.runs().len() == 1).await;
        f.trusted.store(false, Ordering::Release);
        f.checker.interrupt();
        tokio::time::sleep(DELAY * 2).await;
        assert_eq!(f.runs().len(), 1);
        assert!(f.events.lock().is_empty());
        f.checker.stop();
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn files_no_longer_checked_lose_their_diagnostics() {
        let f = Fixture::new();
        let a = f.file("A.php");
        f.report(&a, &["constant.notFound"]);
        f.checker.files_saved([a.clone()]);
        f.until("the check", |f| f.diagnostics().len() == 1).await;
        // PHPStan removed from the project: saving A no longer checks it and drops its errors.
        std::fs::remove_file(f.root.join("vendor/bin/phpstan")).unwrap();
        f.checker.files_saved([a.clone()]);
        f.until("the clear", |f| f.diagnostics().len() == 2).await;
        assert_eq!(f.diagnostics()[1], (a, vec![]));
        assert_eq!(f.runs().len(), 1);
        f.checker.stop();
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn removed_files_lose_their_diagnostics() {
        let f = Fixture::new();
        let a = f.file("A.php");
        f.report(&a, &["constant.notFound"]);
        f.checker.files_saved([a.clone()]);
        f.until("the check", |f| f.diagnostics().len() == 1).await;
        f.checker.files_removed([f.root.join("src/other")].iter());
        assert_eq!(f.diagnostics().len(), 1);
        f.checker.files_removed([f.root.join("src")].iter());
        assert_eq!(f.diagnostics()[1], (a, vec![]));
        f.checker.stop();
    }
}
