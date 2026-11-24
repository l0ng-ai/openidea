use ide_core::{CancellationToken, IdeError, IdeResult, Pos, TextEdit};
use ide_search::{
    LiteralKind, LiteralRange, ReplaceEvent, ReplaceHost, ReplaceTarget, SearchQuery, SearchScope, preserve_case,
    preview, replace_files, replace_files_in_context, replacement_edits,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

fn query(pattern: &str) -> SearchQuery {
    SearchQuery {
        pattern: pattern.into(),
        is_regex: false,
        case_sensitive: false,
        whole_word: false,
        include: vec![],
        exclude: vec![],
        scope: SearchScope::Project,
        max_matches: 0,
        context: Default::default(),
        include_excluded: false,
    }
}

fn regex(pattern: &str) -> SearchQuery {
    SearchQuery { is_regex: true, ..query(pattern) }
}

/// In-memory documents: each `edit_file` is one atomic step (like one undoable
/// `DocPatched`), recorded in `steps`.
#[derive(Default)]
struct FakeDocs {
    files: Mutex<HashMap<PathBuf, String>>,
    steps: Mutex<Vec<(PathBuf, usize)>>,
    /// Cancel this token after the first edited file.
    cancel_after_first: Option<CancellationToken>,
}

impl FakeDocs {
    fn with(files: &[(&str, &str)]) -> Self {
        let docs = Self::default();
        for (p, t) in files {
            docs.files.lock().unwrap().insert(PathBuf::from(p), (*t).to_owned());
        }
        docs
    }
    fn text(&self, p: &str) -> String {
        self.files.lock().unwrap()[Path::new(p)].clone()
    }
}

impl ReplaceHost for FakeDocs {
    fn edit_file(&self, path: &Path, compute: &mut dyn FnMut(&str) -> IdeResult<Vec<TextEdit>>) -> IdeResult<u32> {
        let mut files = self.files.lock().unwrap();
        let text = files.get(path).cloned().ok_or_else(|| IdeError::not_found("no such file"))?;
        let edits = compute(&text)?;
        if !edits.is_empty() {
            files.insert(path.to_owned(), ide_search::apply_edits(&text, &edits));
            self.steps.lock().unwrap().push((path.to_owned(), edits.len()));
        }
        if let Some(c) = &self.cancel_after_first {
            c.cancel();
        }
        Ok(edits.len() as u32)
    }
}

fn targets(paths: &[&str]) -> Vec<ReplaceTarget> {
    paths.iter().map(|p| ReplaceTarget { path: PathBuf::from(p).into(), only: None, skip: None }).collect()
}

#[test]
fn edits_use_utf16_positions() {
    let edits = replacement_edits("é foo\n😀 foo foo", &query("foo"), "bar", false, None).unwrap();
    let starts: Vec<Pos> = edits.iter().map(|e| e.range.start).collect();
    assert_eq!(starts, vec![Pos::new(0, 2), Pos::new(1, 3), Pos::new(1, 7)]);
    assert_eq!(edits[0].range.end, Pos::new(0, 5));
}

#[test]
fn only_selected_matches_are_replaced() {
    let text = "foo foo\nfoo";
    let only = [Pos::new(0, 4), Pos::new(1, 0), Pos::new(5, 5)];
    let p = preview(text, &query("foo"), "x", false, Some(&only)).unwrap();
    assert_eq!(p.after, "foo x\nx");
    assert_eq!(p.edits.len(), 2);
    assert_eq!(p.before, text);
}

#[test]
fn regex_groups_and_escapes() {
    let p = preview("let a = 1;\nlet bb = 22;", &regex(r"(\w+) = (\d+)"), r"$2 = $1\t", false, None).unwrap();
    assert_eq!(p.after, "let 1 = a\t;\nlet 22 = bb\t;");
    let p = preview("k=v", &regex("(?P<key>\\w)=(?P<val>\\w)"), "${val}=${key}", false, None).unwrap();
    assert_eq!(p.after, "v=k");
}

#[test]
fn preserve_case_rules() {
    assert_eq!(preserve_case("FOO", "bar"), "BAR");
    assert_eq!(preserve_case("Foo", "bar"), "Bar");
    assert_eq!(preserve_case("foo", "Bar"), "bar");
    assert_eq!(preserve_case("F", "bar"), "Bar");
    assert_eq!(preserve_case("123", "bar"), "bar");
    let p = preview("foo Foo FOO", &query("foo"), "bar", true, None).unwrap();
    assert_eq!(p.after, "bar Bar BAR");
}

#[test]
fn replace_files_one_step_per_file_with_progress() {
    let docs = FakeDocs::with(&[("a", "foo foo"), ("b", "nothing"), ("c", "x foo")]);
    let events = Arc::new(Mutex::new(Vec::new()));
    let ev = events.clone();
    let summary = replace_files(
        &docs,
        &query("foo"),
        "bar",
        false,
        &targets(&["a", "b", "c", "missing"]),
        &CancellationToken::new(),
        &move |e| ev.lock().unwrap().push(e),
    )
    .unwrap();
    assert_eq!(docs.text("a"), "bar bar");
    assert_eq!(docs.text("c"), "x bar");
    assert_eq!(*docs.steps.lock().unwrap(), vec![(PathBuf::from("a"), 2), (PathBuf::from("c"), 1)]);
    assert_eq!((summary.files, summary.replacements, summary.failed, summary.cancelled), (2, 3, 1, false));
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 4);
    assert!(matches!(&events[0], ReplaceEvent::File { replacements: 2, done: 1, total: 4, .. }));
    assert!(matches!(&events[1], ReplaceEvent::File { replacements: 0, done: 2, .. }));
    assert!(matches!(&events[3], ReplaceEvent::Failed { done: 4, .. }));
}

#[test]
fn replace_files_honours_cancellation() {
    let cancel = CancellationToken::new();
    let docs = FakeDocs { cancel_after_first: Some(cancel.clone()), ..FakeDocs::with(&[("a", "foo"), ("b", "foo")]) };
    let summary = replace_files(&docs, &query("foo"), "bar", false, &targets(&["a", "b"]), &cancel, &|_| {}).unwrap();
    assert!(summary.cancelled);
    assert_eq!(summary.files, 1);
    assert_eq!(docs.text("a"), "bar");
    assert_eq!(docs.text("b"), "foo");
}

#[test]
fn replace_files_runs_off_thread_and_can_be_cancelled_from_outside() {
    let cancel = CancellationToken::new();
    cancel.cancel();
    let docs = Arc::new(FakeDocs::with(&[("a", "foo")]));
    let d = docs.clone();
    let c = cancel.clone();
    let summary = std::thread::spawn(move || {
        replace_files(&*d, &query("foo"), "bar", false, &targets(&["a"]), &c, &|_| {}).unwrap()
    })
    .join()
    .unwrap();
    assert!(summary.cancelled);
    assert_eq!(docs.text("a"), "foo");
}

#[test]
fn replace_files_respects_selected_matches_and_invalid_patterns() {
    let docs = FakeDocs::with(&[("a", "foo\nfoo\nfoo")]);
    let t = vec![ReplaceTarget { path: "a".into(), only: Some(vec![Pos::new(1, 0)]), skip: None }];
    let s = replace_files(&docs, &query("foo"), "x", false, &t, &CancellationToken::new(), &|_| {}).unwrap();
    assert_eq!(s.replacements, 1);
    assert_eq!(docs.text("a"), "foo\nx\nfoo");
    let err = replace_files(&docs, &regex("("), "x", false, &t, &CancellationToken::new(), &|_| {}).unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::InvalidInput);
}

/// `// …` comments and `"…"` strings of `.rs` files; other files have no syntax tree.
fn toy_literals(path: &Path, text: &str) -> Option<Vec<LiteralRange>> {
    if path.extension().is_none_or(|e| e != "rs") {
        return None;
    }
    let mut out = Vec::new();
    for (i, _) in text.match_indices("//") {
        let end = text[i..].find('\n').map_or(text.len(), |n| i + n);
        out.push(LiteralRange { start: i, end, kind: LiteralKind::Comment });
    }
    let quotes: Vec<usize> = text.match_indices('"').map(|(i, _)| i).collect();
    for pair in quotes.chunks(2) {
        if let [a, b] = pair {
            out.push(LiteralRange { start: *a, end: b + 1, kind: LiteralKind::String });
        }
    }
    out.sort_by_key(|l| l.start);
    Some(out)
}

#[test]
fn replace_files_in_context_keeps_to_the_search_context() {
    use ide_search::SearchContext as C;
    let text = "foo(\"foo\"); // foo\nfoo\n";
    let plain = "foo // foo\n";
    let cases = [
        (C::Any, "x(\"x\"); // x\nx\n", "x // x\n"),
        (C::InComments, "foo(\"foo\"); // x\nfoo\n", plain),
        (C::InStringLiterals, "foo(\"x\"); // foo\nfoo\n", plain),
        (C::ExceptComments, "x(\"x\"); // foo\nx\n", "x // x\n"),
        (C::ExceptStringLiterals, "x(\"foo\"); // x\nx\n", "x // x\n"),
        (C::ExceptCommentsAndStringLiterals, "x(\"foo\"); // foo\nx\n", "x // x\n"),
    ];
    for (context, in_rs, in_txt) in cases {
        let docs = FakeDocs::with(&[("a.rs", text), ("b.txt", plain)]);
        let q = SearchQuery { context, ..query("foo") };
        let t = targets(&["a.rs", "b.txt"]);
        replace_files_in_context(&docs, &q, "x", false, &t, Some(&toy_literals), &CancellationToken::new(), &|_| {})
            .unwrap();
        assert_eq!((docs.text("a.rs").as_str(), docs.text("b.txt").as_str()), (in_rs, in_txt), "{context:?}");
    }
}
