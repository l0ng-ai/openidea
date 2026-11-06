use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ide_core::{FileEdit, IdeEvent, Pos, SharedSink};
use parking_lot::Mutex;

use super::*;
use crate::engine::{CACHE_SUBDIR, EngineConfig};
use crate::project::LayoutConfig;
use crate::stubs::StubFilter;

const WAIT: Duration = Duration::from_secs(60);
const CARET: &str = "/*|*/";

/// Reports every `todo()` call, with a fix replacing it by `done()`.
struct Todo;

impl Inspection for Todo {
    fn id(&self) -> &'static str {
        "PhpTodoCall"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        for (at, _) in cx.text().match_indices("todo()") {
            let (start, end) = (at as u32, at as u32 + 6);
            let fix =
                QuickFix { title: "Replace with done()".into(), edit: cx.edit(start, end, "done()"), preferred: true };
            out.report(start, end, "A todo() call").with_fix(fix);
        }
    }
}

/// Reports `legacy()` calls as deprecated hints.
struct Legacy;

impl Inspection for Legacy {
    fn id(&self) -> &'static str {
        "PhpLegacyCallInspection"
    }

    fn default_severity(&self) -> Severity {
        Severity::Hint
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        for (at, _) in cx.text().match_indices("legacy()") {
            out.report(at as u32, at as u32 + 6, "Legacy").deprecated();
        }
    }
}

/// Reports a problem and then panics.
struct Panics;

impl Inspection for Panics {
    fn id(&self) -> &'static str {
        "PhpPanics"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    fn check(&self, _cx: &InspectionContext<'_>, out: &mut Problems) {
        out.report(0, 1, "half-way");
        panic!("an inspection bug");
    }
}

fn test_set() -> Inspections {
    Inspections::new(vec![Arc::new(Todo), Arc::new(Panics), Arc::new(Legacy)])
}

struct Project {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    engine: Arc<PhpEngine>,
    events: Arc<Mutex<Vec<IdeEvent>>>,
    next_doc: u32,
}

impl Project {
    fn new() -> Self {
        Self::with_files(&[])
    }

    /// A project with `files` on disk (relative path, text), indexed.
    fn with_files(files: &[(&str, &str)]) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("index.php"), "<?php\n").unwrap();
        for (rel, text) in files {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
        let sink: SharedSink = {
            let events = events.clone();
            Arc::new(move |e: IdeEvent| events.lock().push(e))
        };
        let config = EngineConfig {
            cache_dir: base.join("cache").join(CACHE_SUBDIR),
            layout: LayoutConfig { root: root.clone(), ..LayoutConfig::default() },
            stubs: StubFilter::default(),
        };
        let engine = PhpEngine::open(config, sink).unwrap();
        assert!(engine.wait_idle(WAIT));
        engine.set_inspections(test_set());
        Self { _tmp: tmp, root, engine, events, next_doc: 1 }
    }

    fn open(&mut self, rel: &str, text: &str) -> DocId {
        let doc = DocId(self.next_doc);
        self.next_doc += 1;
        self.engine.document_opened(doc, &self.root.join(rel), 1, text);
        doc
    }

    fn inspect(&mut self, text: &str) -> Inspected {
        let doc = self.open("src/a.php", text);
        let found = self.engine.inspect(doc, &CancellationToken::new()).expect("open");
        self.engine.document_closed(doc);
        found
    }

    /// The diagnostics last published for `rel`.
    fn published(&self, rel: &str) -> Option<Vec<Diagnostic>> {
        let path = self.root.join(rel);
        self.events.lock().iter().rev().find_map(|e| match e {
            IdeEvent::Diagnostics { path: p, source, items } if **p == *path => {
                assert_eq!(source, "php");
                Some(items.clone())
            }
            _ => None,
        })
    }
}

/// The text without the caret marker, and the caret's position.
fn caret(text: &str) -> (String, Pos) {
    let at = text.find(CARET).expect("caret");
    let clean = text.replacen(CARET, "", 1);
    let before = &clean[..at];
    let line = before.matches('\n').count() as u32;
    let col = before.rsplit('\n').next().unwrap().encode_utf16().count() as u32;
    (clean, Pos::new(line, col))
}

fn applied(text: &str, edit: &WorkspaceEdit) -> String {
    let [FileEdit::Edit { edits, .. }] = edit.files.as_slice() else { panic!("one file: {edit:?}") };
    let mut document = ide_text::Document::new(text);
    document.apply_edits(edits).unwrap();
    document.text().to_string()
}

/// The diagnostic codes, `syntax` for the parser's errors (several in a row counted once).
fn codes(inspected: &Inspected) -> Vec<String> {
    let mut codes: Vec<String> =
        inspected.diagnostics.iter().map(|d| d.code.clone().unwrap_or_else(|| "syntax".into())).collect();
    codes.dedup();
    codes
}

#[test]
fn problems_follow_syntax_errors_with_codes_and_severities() {
    let mut p = Project::new();
    let found = p.inspect("<?php\nlegacy();\ntodo();\n$x = ;\n");
    assert_eq!(codes(&found), ["syntax", "PhpLegacyCallInspection", "PhpTodoCall"]);
    let syntax = &found.diagnostics[0];
    assert_eq!((syntax.severity, syntax.source.as_deref()), (Severity::Error, Some("php")));
    let legacy = found.problems[0].to_diagnostic();
    assert_eq!((legacy.severity, legacy.deprecated), (Severity::Hint, true));
    assert_eq!(legacy.range, Range::new(Pos::new(1, 0), Pos::new(1, 6)));
    let todo = &found.problems[1];
    assert_eq!((todo.severity, todo.message.as_str()), (Severity::Warning, "A todo() call"));
    assert_eq!(todo.range, Range::new(Pos::new(2, 0), Pos::new(2, 6)));
    assert!(!found.problems.iter().any(|p| p.inspection == "PhpPanics"), "a panicking inspection reports nothing");
}

#[test]
fn cancelled_runs_and_closed_documents_give_nothing() {
    let mut p = Project::new();
    let doc = p.open("src/a.php", "<?php\ntodo();\n");
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(p.engine.inspect(doc, &cancel).is_none());
    p.engine.document_closed(doc);
    assert!(p.engine.inspect(doc, &CancellationToken::new()).is_none());
}

#[test]
fn noinspection_suppresses_the_following_statement_or_member() {
    let mut p = Project::new();
    let text = "<?php\nfunction f() {\n    /** @noinspection PhpTodoCall */\n    todo();\n    todo();\n}\n";
    let found = p.inspect(text);
    assert_eq!(found.problems.len(), 1, "{:?}", found.problems);
    assert_eq!(found.problems[0].range.start.line, 4);

    // A member, the `Inspection` suffix, several ids, other comments in between.
    let text = "<?php\nclass A {\n    /**\n     * Does it.\n     * @noinspection PhpLegacyCall, PhpTodoCallInspection\n     */\n    // a comment\n    public function a() { todo(); legacy(); }\n    public function b() { todo(); }\n}\n";
    let found = p.inspect(text);
    let lines: Vec<u32> = found.problems.iter().map(|p| p.range.start.line).collect();
    assert_eq!(lines, [8]);

    // Another id doesn't suppress; neither does a comment that isn't in front.
    let found = p.inspect("<?php\n/** @noinspection PhpOther */\nfunction f() { todo(); }\n");
    assert_eq!(found.problems.len(), 1);
    let found = p.inspect("<?php\nfunction f() { todo(); }\n/** @noinspection PhpTodoCall */\nfunction g() {}\n");
    assert_eq!(found.problems.len(), 1);
    let found = p.inspect("<?php\n// @noinspection PhpTodoCall\ntodo();\n");
    assert_eq!(found.problems.len(), 1, "line comments don't suppress");

    // `ALL`, and `/* */` comments.
    let found = p.inspect("<?php\n/** @noinspection ALL */\nfunction f() { todo(); legacy(); }\ntodo();\n");
    assert_eq!(found.problems.iter().map(|p| p.range.start.line).collect::<Vec<_>>(), [3]);
    let found = p.inspect("<?php\n/* @noinspection PhpTodoCall */ todo(); todo();\n");
    assert_eq!(found.problems.len(), 1);
}

#[test]
fn noinspection_after_the_opening_tag_suppresses_the_file() {
    let mut p = Project::new();
    let found = p.inspect("<?php\n/** @noinspection PhpTodoCall */\n\nfunction f() { todo(); }\ntodo(); legacy();\n");
    assert_eq!(found.problems.iter().map(|p| p.inspection).collect::<Vec<_>>(), ["PhpLegacyCallInspection"]);
    let found = p.inspect("<?php\n/** @noinspection PhpTodoCall */\nnamespace App;\n\ntodo();\n");
    assert!(found.problems.is_empty(), "{:?}", found.problems);
    let found = p.inspect("<?php\n/** @noinspection PhpTodoCall */\ndeclare(strict_types=1);\ntodo();\n");
    assert!(found.problems.is_empty(), "{:?}", found.problems);
    // Directly in front of the first function: only that function.
    let found = p.inspect("<?php\n/** @noinspection PhpTodoCall */\nfunction f() { todo(); }\ntodo();\n");
    assert_eq!(found.problems.len(), 1);
    // Syntax errors can't be suppressed.
    let found = p.inspect("<?php\n/** @noinspection ALL */\n\n$x = ;\n");
    assert_eq!(codes(&found), ["syntax"]);
}

#[test]
fn suppress_fix_adds_the_tag() {
    let mut p = Project::new();
    let suppress = |p: &mut Project, text: &str| -> String {
        let found = p.inspect(text);
        let todo = found.problems.iter().find(|p| p.inspection == "PhpTodoCall").expect("a problem");
        let fix = todo.fixes.iter().find(|f| f.title == "Suppress 'PhpTodoCall' for statement").expect("suppress");
        assert!(!fix.preferred);
        let fixed = applied(text, &fix.edit);
        assert!(p.inspect(&fixed).problems.iter().all(|p| p.inspection != "PhpTodoCall"), "{fixed}");
        fixed
    };
    // A new line in front of the statement, indented like it.
    assert_eq!(
        suppress(&mut p, "<?php\nfunction f() {\n    $a = 1;\n    todo();\n}\n"),
        "<?php\nfunction f() {\n    $a = 1;\n    /** @noinspection PhpTodoCall */\n    todo();\n}\n"
    );
    // The statement doesn't start its line.
    assert_eq!(
        suppress(&mut p, "<?php\n$a = 1; todo();\n"),
        "<?php\n$a = 1; /** @noinspection PhpTodoCall */ todo();\n"
    );
    // Into the docblock in front: multi-line, single-line, text before the close.
    assert_eq!(
        suppress(&mut p, "<?php\nclass A {\n    /**\n     * Hi.\n     */\n    public function a($x = todo()) {}\n}\n"),
        "<?php\nclass A {\n    /**\n     * Hi.\n     * @noinspection PhpTodoCall\n     */\n    public function a($x = todo()) {}\n}\n"
    );
    assert_eq!(
        suppress(&mut p, "<?php\n/** @var int $x */\n$x = todo();\n"),
        "<?php\n/**\n * @var int $x\n * @noinspection PhpTodoCall\n */\n$x = todo();\n"
    );
    assert_eq!(
        suppress(&mut p, "<?php\n/**\n * Hi. */\nfunction f($a = todo()) {}\n"),
        "<?php\n/**\n * Hi. \n * @noinspection PhpTodoCall\n */\nfunction f($a = todo()) {}\n"
    );
    // CRLF files get CRLF (the test document normalizes line ends, so look at the edit).
    let text = "<?php\r\nif (true) {\r\n\ttodo();\r\n}\r\n";
    assert_eq!(suppress(&mut p, text), "<?php\nif (true) {\n\t/** @noinspection PhpTodoCall */\n\ttodo();\n}\n");
    let found = p.inspect(text);
    let fix = found.problems[0].fixes.iter().find(|f| f.title.starts_with("Suppress")).unwrap();
    let [FileEdit::Edit { edits, .. }] = fix.edit.files.as_slice() else { panic!() };
    assert_eq!(edits[0].new_text, "/** @noinspection PhpTodoCall */\r\n\t");
    assert_eq!(edits[0].range, Range::new(Pos::new(2, 1), Pos::new(2, 1)));
}

#[test]
fn code_actions_give_the_fixes_at_the_range() {
    let mut p = Project::new();
    let (text, pos) = caret("<?php\nlegacy();\nto/*|*/do();\ntodo();\n");
    let doc = p.open("src/a.php", &text);
    let at = Range::new(pos, pos);
    let titles = |actions: &[ImportAction]| actions.iter().map(|a| a.title.clone()).collect::<Vec<_>>();
    let actions = p.engine.code_actions(doc, at, &[]).unwrap();
    assert_eq!(titles(&actions), ["Replace with done()", "Suppress 'PhpTodoCall' for statement"]);
    assert!(actions[0].preferred && actions.iter().all(|a| a.kind == QUICKFIX));
    assert_eq!(applied(&text, &actions[0].edit), "<?php\nlegacy();\ndone();\ntodo();\n");
    // A problem without fixes still offers its suppression; nothing outside the problems.
    let first = Range::new(Pos::new(1, 2), Pos::new(1, 2));
    assert_eq!(
        titles(&p.engine.code_actions(doc, first, &[]).unwrap()),
        ["Suppress 'PhpLegacyCallInspection' for statement"]
    );
    assert!(p.engine.code_actions(doc, Range::new(Pos::new(0, 1), Pos::new(0, 1)), &[]).unwrap().is_empty());
    // Two problems in the range: the fixes first, the same fix title once.
    let both = Range::new(Pos::new(2, 0), Pos::new(3, 6));
    assert_eq!(
        titles(&p.engine.code_actions(doc, both, &[]).unwrap()),
        ["Replace with done()", "Suppress 'PhpTodoCall' for statement"]
    );
    // Only other kinds asked for.
    assert!(p.engine.code_actions(doc, at, &["source.organizeImports".into()]).unwrap().is_empty());
    assert!(p.engine.code_actions(DocId(999), at, &[]).is_none());
}

#[test]
fn background_run_publishes_and_clears_diagnostics() {
    let mut p = Project::new();
    let doc = p.open("src/a.php", "<?php\ntodo();\n");
    assert!(p.engine.wait_inspections(WAIT));
    let published = p.published("src/a.php").expect("published after opening");
    assert_eq!(published.iter().map(|d| d.code.as_deref()).collect::<Vec<_>>(), [Some("PhpTodoCall")]);

    // Changes in quick succession: one run for the last version.
    p.events.lock().clear();
    p.engine.document_changed(doc, 2, "<?php\n$x = ;\n");
    p.engine.document_changed(doc, 3, "<?php\n$x = ;\ntodo(); todo();\n");
    assert!(p.engine.wait_inspections(WAIT));
    let runs = p.events.lock().iter().filter(|e| matches!(e, IdeEvent::Diagnostics { .. })).count();
    assert_eq!(runs, 1, "debounced");
    let published = p.published("src/a.php").unwrap();
    let published: Vec<(Option<&str>, Severity)> = published.iter().map(|d| (d.code.as_deref(), d.severity)).collect();
    assert_eq!(published[0], (None, Severity::Error), "the syntax errors first");
    assert_eq!(published.iter().filter(|d| d.0 == Some("PhpTodoCall")).count(), 2, "{published:?}");
    assert_eq!(published.last().unwrap().0, Some("PhpTodoCall"));
    // The cached result is the current version's.
    assert_eq!(p.engine.inspected(doc).unwrap().version, 3);

    p.engine.document_closed(doc);
    assert_eq!(p.published("src/a.php"), Some(Vec::new()), "cleared on close");

    // Stopping the engine clears what it published.
    let other = p.open("src/b.php", "<?php\ntodo();\n");
    assert!(p.engine.wait_inspections(WAIT));
    assert_eq!(p.published("src/b.php").unwrap().len(), 1);
    let _ = other;
    p.engine.shutdown();
    assert_eq!(p.published("src/b.php"), Some(Vec::new()), "cleared on shutdown");
}

#[test]
fn replacing_the_inspections_runs_them_again() {
    let mut p = Project::new();
    let doc = p.open("src/a.php", "<?php\ntodo();\n");
    assert!(p.engine.wait_inspections(WAIT));
    assert_eq!(p.published("src/a.php").unwrap().len(), 1);
    p.engine.set_inspections(Inspections::default());
    assert!(p.engine.wait_inspections(WAIT));
    assert_eq!(p.published("src/a.php"), Some(Vec::new()));
    assert!(p.engine.inspected(doc).unwrap().problems.is_empty());
    assert_eq!(p.engine.inspections().ids(), Vec::<&str>::new());
    p.engine.set_inspections(Inspections::builtin());
    assert_eq!(
        p.engine.inspections().ids(),
        [
            "PhpUndefinedClass",
            "PhpUndefinedFunction",
            "PhpUndefinedConstant",
            "PhpUndefinedMethod",
            "PhpUndefinedField",
            "PhpUndefinedClassConstant",
            "PhpUndefinedVariable",
            "PhpUnusedLocalVariable",
            "PhpMethodParametersCountMismatch",
            "PhpUnknownNamedArgument",
            "PhpParams",
            "PhpIncompatibleReturnType",
            "PhpFieldAssignmentTypeMismatch",
            "PhpUnusedAlias",
            "PhpUnusedPrivateMethod",
            "PhpUnusedPrivateField",
            "PhpUnusedPrivateConstant",
            "PhpUnusedParameter",
        ]
    );
}

#[test]
fn tag_ids_and_matching() {
    use super::suppress::Suppressions;
    let parsed = crate::syntax::ParsedFile::parse(
        "a.php",
        "<?php\n/**\n * @noinspection A, BInspection C\n * @noinspectionX D\n * @noinspection E (why) F\n */\n$a = 1;\n",
    );
    let found = Suppressions::scan(&parsed);
    assert_eq!(found.list.len(), 1);
    assert_eq!(found.list[0].ids, ["A", "BInspection", "C", "E"]);
    let at = parsed.text().find("$a").unwrap() as u32;
    assert!(found.suppresses("AInspection", at));
    assert!(found.suppresses("b", at));
    assert!(!found.suppresses("D", at) && !found.suppresses("F", at));
}

/// The built-in inspections without the variable and unused code ones.
fn without_variables() -> Inspections {
    Inspections::new(
        Inspections::builtin()
            .iter()
            .filter(|i| !i.id().contains("Variable") && !i.id().starts_with("PhpUnused"))
            .cloned()
            .collect(),
    )
}

#[path = "undefined_tests.rs"]
mod undefined_tests;

#[path = "members_tests.rs"]
mod members_tests;

#[path = "variables_tests.rs"]
mod variables_tests;

#[path = "calls_tests.rs"]
mod calls_tests;

#[path = "unused_tests.rs"]
mod unused_tests;
