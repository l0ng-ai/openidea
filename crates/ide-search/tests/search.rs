use ide_core::CancellationToken;
use ide_core::error::ErrorKind;
use ide_search::{FileMatches, LineMatch, SearchQuery, SearchScope, SearchSummary, replace_in_text, search};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use tempfile::TempDir;

fn project(files: &[(&str, &[u8])]) -> TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (path, content) in files {
        let path = dir.path().join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
    dir
}

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
    }
}

fn regex(pattern: &str) -> SearchQuery {
    SearchQuery { is_regex: true, ..query(pattern) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct View {
    rel_path: String,
    matches: Vec<LineMatch>,
}

fn run_with(
    root: &Path,
    q: &SearchQuery,
    overlay: &(dyn Fn(&Path) -> Option<String> + Sync),
    cancel: &CancellationToken,
) -> (Vec<FileMatches>, SearchSummary) {
    let out = Mutex::new(Vec::new());
    let summary = search(root, q, overlay, cancel, &|f| out.lock().unwrap().push(f)).unwrap();
    let mut files = out.into_inner().unwrap();
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    (files, summary)
}

fn run(root: &Path, q: &SearchQuery) -> (Vec<View>, SearchSummary) {
    let (files, summary) = run_with(root, q, &|_| None, &CancellationToken::new());
    for f in &files {
        assert!(f.path.starts_with(root) || !f.path.is_absolute(), "{:?}", f.path);
    }
    let views = files.into_iter().map(|f| View { rel_path: f.rel_path, matches: f.matches }).collect();
    (views, summary)
}

fn paths(views: &[View]) -> Vec<&str> {
    views.iter().map(|v| v.rel_path.as_str()).collect()
}

fn total(views: &[View]) -> usize {
    views.iter().flat_map(|v| &v.matches).map(|m| m.ranges.len()).sum()
}

#[test]
fn literal_search_shape() {
    let p = project(&[
        ("src/main.rs", b"fn main() {\n    let foo = Foo::new();\n    foo.run(foo);\n}\n"),
        ("src/lib.rs", b"pub mod foo;\n"),
        ("README.md", b"nothing here\n"),
    ]);
    let (views, summary) = run(p.path(), &query("foo"));
    assert_eq!(summary.files, 2);
    assert_eq!(summary.matches, 5);
    assert!(!summary.limit_hit && !summary.cancelled);
    insta::assert_yaml_snapshot!(views);
}

#[test]
fn literal_escapes_regex_metacharacters() {
    let p = project(&[("a.txt", b"a.b\naxb\n(a.b)\n")]);
    let (views, _) = run(p.path(), &query("a.b"));
    assert_eq!(views[0].matches.iter().map(|m| m.line).collect::<Vec<_>>(), vec![0, 2]);
    let (views, _) = run(p.path(), &query("(a.b)"));
    assert_eq!(views[0].matches[0].ranges, vec![(0, 5)]);
}

#[test]
fn case_sensitivity() {
    let p = project(&[("a.txt", b"Foo foo FOO\n")]);
    let (views, _) = run(p.path(), &query("foo"));
    assert_eq!(views[0].matches[0].ranges, vec![(0, 3), (4, 7), (8, 11)]);
    let (views, _) = run(p.path(), &SearchQuery { case_sensitive: true, ..query("foo") });
    assert_eq!(views[0].matches[0].ranges, vec![(4, 7)]);
    // No smart case: an uppercase letter does not imply case sensitivity.
    let (views, _) = run(p.path(), &query("Foo"));
    assert_eq!(views[0].matches[0].ranges.len(), 3);
}

#[test]
fn regex_search() {
    let p = project(&[("a.txt", b"let x1 = 10;\nlet yy = 2;\nconst z = 3;\n")]);
    let (views, summary) = run(p.path(), &regex(r"let (\w+) = \d+"));
    assert_eq!(summary.matches, 2);
    assert_eq!(views[0].matches[0].ranges, vec![(0, 11)]);
    assert_eq!(views[0].matches[1].ranges, vec![(0, 10)]);
    let (views, _) = run(p.path(), &regex(r"^\w+"));
    assert_eq!(total(&views), 3);
    let (views, _) = run(p.path(), &regex(r"\d+;$"));
    assert_eq!(views[0].matches.iter().map(|m| m.ranges[0]).collect::<Vec<_>>(), vec![(9, 12), (9, 11), (10, 12)]);
}

#[test]
fn whole_word() {
    let p = project(&[("a.txt", b"foo foobar barfoo foo_bar (foo) foo\n")]);
    let (views, _) = run(p.path(), &SearchQuery { whole_word: true, ..query("foo") });
    assert_eq!(views[0].matches[0].ranges, vec![(0, 3), (27, 30), (32, 35)]);
    let (views, _) = run(p.path(), &SearchQuery { whole_word: true, ..regex("fo+") });
    assert_eq!(views[0].matches[0].ranges, vec![(0, 3), (27, 30), (32, 35)]);
}

#[test]
fn invalid_regex_is_reported() {
    let p = project(&[("a.txt", b"x\n")]);
    let err = search(p.path(), &regex("a(b"), &|_| None, &CancellationToken::new(), &|_| {}).unwrap_err();
    assert_eq!(err.kind, ErrorKind::InvalidInput);
    assert!(err.message.contains("Invalid regular expression"), "{}", err.message);
    let err = search(p.path(), &regex("[z-a]"), &|_| None, &CancellationToken::new(), &|_| {}).unwrap_err();
    assert_eq!(err.kind, ErrorKind::InvalidInput);
}

#[test]
fn invalid_mask_is_reported() {
    let p = project(&[("a.txt", b"x\n")]);
    let q = SearchQuery { include: vec!["*.{rs".into()], ..query("x") };
    let err = search(p.path(), &q, &|_| None, &CancellationToken::new(), &|_| {}).unwrap_err();
    assert_eq!(err.kind, ErrorKind::InvalidInput);
}

#[test]
fn empty_pattern_finds_nothing() {
    let p = project(&[("a.txt", b"x\n")]);
    let (views, summary) = run(p.path(), &query(""));
    assert!(views.is_empty());
    assert_eq!(summary.matches, 0);
}

fn mask_project() -> TempDir {
    project(&[
        ("src/Main.kt", b"hit\n"),
        ("src/MainTest.kt", b"hit\n"),
        ("src/Util.java", b"hit\n"),
        ("src/web/app.ts", b"hit\n"),
        ("lib/other.ts", b"hit\n"),
        ("notes.md", b"hit\n"),
    ])
}

#[test]
fn file_masks() {
    let p = mask_project();
    let with = |include: &[&str], exclude: &[&str]| {
        let q = SearchQuery {
            include: include.iter().map(|s| s.to_string()).collect(),
            exclude: exclude.iter().map(|s| s.to_string()).collect(),
            ..query("hit")
        };
        let (views, _) = run(p.path(), &q);
        paths(&views).into_iter().map(String::from).collect::<Vec<_>>()
    };
    assert_eq!(with(&["*.kt"], &[]), ["src/Main.kt", "src/MainTest.kt"]);
    assert_eq!(with(&["*.kt, *.java, !*Test.kt"], &[]), ["src/Main.kt", "src/Util.java"]);
    assert_eq!(with(&["*.kt", "*.java"], &["*Test.kt"]), ["src/Main.kt", "src/Util.java"]);
    assert_eq!(with(&["src/**/*.ts"], &[]), ["src/web/app.ts"]);
    assert_eq!(with(&["*.ts"], &["src/**"]), ["lib/other.ts"]);
    assert_eq!(with(&["!*.md"], &[]).len(), 5);
    assert_eq!(with(&[], &["*.kt,*.ts"]), ["notes.md", "src/Util.java"]);
}

/// The files of `scope` under `root` (relative), sorted.
fn scope_rels(root: &Path, scope: &SearchScope) -> Vec<String> {
    let none = ide_search::FileMask::new(&[], &[]).unwrap();
    let files = ide_search::scope_files(root, scope, &none, None, &CancellationToken::new()).unwrap();
    let mut rels: Vec<_> = files.into_iter().map(|f| f.rel_path).collect();
    rels.sort();
    rels
}

#[test]
fn searches_ignored_and_hidden_files_but_not_ignored_folders() {
    // #1317: like IDEA, only ignored folders are left out; ignored files and dotfiles are searched.
    // (path, content, walked): every file mentions `needle`.
    let files: &[(&str, &[u8], bool)] = &[
        (".gitignore", b"# needle\ntarget/\n*.log\n.env\nsrc/local/\n", true),
        (".ignore", b"# needle\ngenerated.rs\nout/\n", true),
        ("src/a.rs", b"needle\n", true),
        // Ignored files outside ignored folders.
        ("src/generated.rs", b"needle\n", true),
        ("build.log", b"needle\n", true),
        (".env", b"needle\n", true),
        ("sub/.gitignore", b"# needle\nlocal.txt\ncache/\n", true),
        ("sub/local.txt", b"needle\n", true),
        ("sub/kept.txt", b"needle\n", true),
        // Hidden files and folders.
        (".eslintrc", b"needle\n", true),
        (".github/workflows/ci.yml", b"needle\n", true),
        (".hidden/secret.rs", b"needle\n", true),
        // Ignored folders, whatever they hold.
        ("target/debug/out.rs", b"needle\n", false),
        ("target/.env", b"needle\n", false),
        ("src/local/notes.txt", b"needle\n", false),
        ("out/gen.rs", b"needle\n", false),
        ("sub/cache/blob.txt", b"needle\n", false),
        // Never: Git's own folder.
        (".git/config", b"needle\n", false),
    ];
    let p = project(&files.iter().map(|(path, text, _)| (*path, *text)).collect::<Vec<_>>());
    let mut expected: Vec<&str> = files.iter().filter(|(_, _, walked)| *walked).map(|(path, _, _)| *path).collect();
    expected.sort();

    let (views, _) = run(p.path(), &query("needle"));
    assert_eq!(paths(&views), expected, "Find in Files");

    assert_eq!(scope_rels(p.path(), &SearchScope::Project), expected, "scope files");

    // A directory scope and an explicit ignored file are searched the same way.
    let dir = SearchScope::Directory { path: ide_core::IpcPath(p.path().join("sub")) };
    let (views, _) = run(p.path(), &SearchQuery { scope: dir, ..query("needle") });
    assert_eq!(paths(&views), ["sub/.gitignore", "sub/kept.txt", "sub/local.txt"]);
    let one = SearchScope::Files { paths: vec![ide_core::IpcPath(p.path().join("build.log"))] };
    let (views, _) = run(p.path(), &SearchQuery { scope: one, ..query("needle") });
    assert_eq!(paths(&views), ["build.log"]);
}

#[test]
fn nested_repository_ignores_outer_repository_rules() {
    // #1254: the opened project is a Git repository inside a folder its parent repository ignores.
    let p = project(&[
        (".git/HEAD", b"ref: refs/heads/main\n"),
        ("projects/.gitignore", b"*\n!.gitignore\n"),
        ("projects/nested/.git/HEAD", b"ref: refs/heads/main\n"),
        ("projects/nested/.gitignore", b"logs/\n"),
        ("projects/nested/search-test.txt", b"somesss\n"),
        ("projects/nested/src/main.txt", b"somesss\n"),
        ("projects/nested/logs/debug.txt", b"somesss\n"),
    ]);
    let nested = p.path().join("projects/nested");
    let (views, _) = run(&nested, &query("somesss"));
    assert_eq!(paths(&views), ["search-test.txt", "src/main.txt"]);
    assert_eq!(scope_rels(&nested, &SearchScope::Project), [".gitignore", "search-test.txt", "src/main.txt"]);
}

#[test]
fn skips_binary_files() {
    let mut late_nul = b"needle\n".to_vec();
    late_nul.extend(std::iter::repeat_n(b'a', 200_000));
    late_nul.extend(b"\0\nneedle\n");
    let p = project(&[("text.txt", b"needle\n"), ("image.bin", b"\x89PNG\0\0needle\0"), ("late.bin", &late_nul)]);
    let (views, summary) = run(p.path(), &query("needle"));
    assert_eq!(paths(&views), ["text.txt"]);
    assert_eq!(summary.matches, 1);
}

#[test]
fn overlay_takes_precedence() {
    let p = project(&[("a.txt", b"old needle\n"), ("b.txt", b"nothing\n")]);
    let b = p.path().join("b.txt");
    let a = p.path().join("a.txt");
    let overlay = move |path: &Path| -> Option<String> {
        if path == b {
            Some("first\nunsaved needle here\n".into())
        } else if path == a {
            Some("edited away\n".into())
        } else {
            None
        }
    };
    let (files, _) = run_with(p.path(), &query("needle"), &overlay, &CancellationToken::new());
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].rel_path, "b.txt");
    assert_eq!(files[0].path, p.path().join("b.txt"));
    assert_eq!(files[0].matches[0].line, 1);
    assert_eq!(files[0].matches[0].ranges, vec![(8, 14)]);
}

#[test]
fn match_limit() {
    let line = b"x x x x x\n";
    let p = project(&[("a.txt", line), ("b.txt", line), ("c.txt", line)]);
    let (views, summary) = run(p.path(), &SearchQuery { max_matches: 7, ..query("x") });
    assert!(summary.limit_hit);
    assert_eq!(summary.matches, 7);
    assert_eq!(total(&views), 7);
    assert_eq!(summary.files as usize, views.len());

    let (views, summary) = run(p.path(), &SearchQuery { max_matches: 15, ..query("x") });
    assert!(!summary.limit_hit);
    assert_eq!(total(&views), 15);

    let (_, summary) = run(p.path(), &SearchQuery { max_matches: 14, ..query("x") });
    assert!(summary.limit_hit);
    assert_eq!(summary.matches, 14);
}

#[test]
fn default_limit_is_ten_thousand() {
    let content = "a\n".repeat(10_050);
    let p = project(&[("a.txt", content.as_bytes())]);
    let (views, summary) = run(p.path(), &query("a"));
    assert!(summary.limit_hit);
    assert_eq!(summary.matches, 10_000);
    assert_eq!(views[0].matches.len(), 10_000);
}

#[test]
fn cancelled_before_start() {
    let p = project(&[("a.txt", b"x\n")]);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let (files, summary) = run_with(p.path(), &query("x"), &|_| None, &cancel);
    assert!(summary.cancelled);
    assert!(files.is_empty());
}

#[test]
fn cancelled_mid_search() {
    let files: Vec<(String, Vec<u8>)> =
        (0..400).map(|i| (format!("d{}/f{i}.txt", i % 10), b"hit\n".to_vec())).collect();
    let refs: Vec<(&str, &[u8])> = files.iter().map(|(p, c)| (p.as_str(), c.as_slice())).collect();
    let p = project(&refs);
    let cancel = CancellationToken::new();
    let seen = AtomicUsize::new(0);
    let summary = search(p.path(), &query("hit"), &|_| None, &cancel, &|_| {
        seen.fetch_add(1, Ordering::SeqCst);
        cancel.cancel();
    })
    .unwrap();
    assert!(summary.cancelled);
    let seen = seen.load(Ordering::SeqCst);
    assert!(seen < 400, "search kept going after cancel: {seen}");
    assert_eq!(summary.files as usize, seen);
}

#[test]
fn cancel_interrupts_large_file() {
    // 64 MiB without matches: the reader must notice cancellation mid-file.
    let p = project(&[]);
    let big = p.path().join("big.txt");
    let line = "abcdefghijklmnopqrstuvwxyz0123456789\n".repeat(1024);
    {
        use std::io::Write;
        let mut f = std::io::BufWriter::new(std::fs::File::create(&big).unwrap());
        for _ in 0..(64 * 1024 * 1024 / line.len()) {
            f.write_all(line.as_bytes()).unwrap();
        }
        f.write_all(b"needle\n").unwrap();
    }
    let cancel = CancellationToken::new();
    let canceller = cancel.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(5));
        canceller.cancel();
    });
    let (files, summary) = run_with(p.path(), &regex("ne+dle"), &|_| None, &cancel);
    t.join().unwrap();
    assert!(summary.cancelled);
    assert!(files.is_empty());
}

#[test]
fn unicode_columns_are_utf16() {
    let p = project(&[("i18n.txt", "中文字符 needle 😀 needle\n🎉🎉needle\nnaïve Needle ünïcödé\n".as_bytes())]);
    let (views, _) = run(p.path(), &query("needle"));
    assert_eq!(views[0].matches[0].ranges, vec![(5, 11), (15, 21)]);
    assert_eq!(views[0].matches[1].ranges, vec![(4, 10)]);
    assert_eq!(views[0].matches[2].ranges, vec![(6, 12)]);
    let (cjk, _) = run(p.path(), &query("字符"));
    assert_eq!(cjk[0].matches[0].ranges, vec![(2, 4)]);
    let (emoji, _) = run(p.path(), &query("😀"));
    assert_eq!(emoji[0].matches[0].ranges, vec![(12, 14)]);
    // Unicode-aware case folding.
    let (folded, _) = run(p.path(), &query("ÜNÏCÖDÉ"));
    assert_eq!(folded[0].matches[0].ranges, vec![(13, 20)]);
    insta::assert_yaml_snapshot!(views);
}

#[test]
fn long_lines_are_truncated() {
    let long = format!("{}needle{}needle{}\nshort needle\n", "a".repeat(2000), "b".repeat(100), "c".repeat(2000));
    let p = project(&[("min.js", long.as_bytes())]);
    let (views, _) = run(p.path(), &query("needle"));
    let first = &views[0].matches[0];
    assert_eq!(first.text_offset, 1900);
    assert_eq!(first.ranges, vec![(100, 106), (206, 212)]);
    assert_eq!(first.text.encode_utf16().count(), 500);
    assert_eq!(&first.text[100..106], "needle");
    let second = &views[0].matches[1];
    assert_eq!(second.text_offset, 0);
    assert_eq!(second.text, "short needle");
}

#[test]
fn multi_line_matches() {
    let p = project(&[("a.rs", b"fn foo() {\n    bar();\n}\nfoo\nbar\n")]);
    let (views, summary) = run(p.path(), &regex(r"\{\n\s*bar"));
    assert_eq!(summary.matches, 1);
    insta::assert_yaml_snapshot!("multi_line_regex", views);

    let (views, _) = run(p.path(), &query("foo\nbar"));
    assert_eq!(views[0].matches.len(), 1);
    assert_eq!(views[0].matches[0].line, 3);
    assert_eq!(views[0].matches[0].ranges, vec![(0, 3)]);
}

#[test]
fn adjacent_multi_line_matches() {
    let p = project(&[("a.txt", b"a\nb\na\nb\n")]);
    let (views, summary) = run(p.path(), &regex(r"a\nb"));
    assert_eq!(summary.matches, 2);
    assert_eq!(
        views[0].matches.iter().map(|m| (m.line, m.ranges.clone())).collect::<Vec<_>>(),
        [(0, vec![(0, 1)]), (2, vec![(0, 1)])]
    );
}

#[test]
fn empty_matches_respect_char_boundaries() {
    let p = project(&[("e.txt", "😀中x\n".as_bytes())]);
    let (views, _) = run(p.path(), &regex("x*"));
    assert_eq!(views[0].matches[0].ranges, vec![(0, 0), (2, 2), (3, 4)]);
}

#[test]
fn crlf_lines() {
    let p = project(&[("win.txt", b"alpha beta\r\ngamma beta\r\n")]);
    let (views, _) = run(p.path(), &regex("beta$"));
    assert_eq!(views[0].matches.len(), 2);
    assert_eq!(views[0].matches[0].text, "alpha beta");
    assert_eq!(views[0].matches[1].ranges, vec![(6, 10)]);
}

#[test]
fn directory_scope() {
    let p = mask_project();
    let q = SearchQuery { scope: SearchScope::Directory { path: "src/web".into() }, ..query("hit") };
    let (views, _) = run(p.path(), &q);
    assert_eq!(paths(&views), ["src/web/app.ts"]);
    let q = SearchQuery { scope: SearchScope::Directory { path: p.path().join("lib").into() }, ..query("hit") };
    let (views, _) = run(p.path(), &q);
    assert_eq!(paths(&views), ["lib/other.ts"]);
    let q = SearchQuery { scope: SearchScope::Directory { path: "missing".into() }, ..query("hit") };
    let err = search(p.path(), &q, &|_| None, &CancellationToken::new(), &|_| {}).unwrap_err();
    assert_eq!(err.kind, ErrorKind::NotFound);
}

#[test]
fn pattern_scope_intersects_the_file_mask() {
    let p = mask_project();
    let scope = SearchScope::Pattern { pattern: "file:src//*&&!file:*Test*".into() };
    let q = SearchQuery { scope: scope.clone(), ..query("hit") };
    let (views, _) = run(p.path(), &q);
    assert_eq!(paths(&views), ["src/Main.kt", "src/Util.java", "src/web/app.ts"]);
    let q = SearchQuery { scope, include: vec!["*.ts".into()], ..query("hit") };
    let (views, _) = run(p.path(), &q);
    assert_eq!(paths(&views), ["src/web/app.ts"]);
    let bad = SearchQuery { scope: SearchScope::Pattern { pattern: "a &&".into() }, ..query("hit") };
    assert_eq!(ide_search::validate_query(&bad).unwrap_err().kind, ErrorKind::InvalidInput);
}

#[test]
fn files_scope_searches_ignored_and_unsaved_files() {
    let p = project(&[(".gitignore", b"*.log\n"), ("a.log", b"hit\n"), ("b.txt", b"hit\n"), ("c.txt", b"hit\n")]);
    let unsaved = p.path().join("new.txt");
    let unsaved2 = unsaved.clone();
    let overlay = move |path: &Path| (path == unsaved2).then(|| "hit\n".to_string());
    let q = SearchQuery {
        scope: SearchScope::Files {
            paths: vec!["a.log".into(), p.path().join("b.txt").into(), "a.log".into(), unsaved.clone().into()],
        },
        ..query("hit")
    };
    let (files, summary) = run_with(p.path(), &q, &overlay, &CancellationToken::new());
    let names: Vec<_> = files.iter().map(|f| f.rel_path.as_str()).collect();
    assert_eq!(names, ["a.log", "b.txt", "new.txt"]);
    assert_eq!(summary.files, 3);
}

#[test]
fn utf16_encoded_files_are_transcoded() {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in "hello needle\n".encode_utf16() {
        bytes.extend(unit.to_le_bytes());
    }
    let p = project(&[("utf16.txt", &bytes)]);
    let (views, _) = run(p.path(), &query("needle"));
    assert_eq!(views[0].matches[0].text, "hello needle");
    assert_eq!(views[0].matches[0].ranges, vec![(6, 12)]);
}

// ---- replace ----

#[test]
fn replace_literal() {
    let (out, n) = replace_in_text("a.b axb A.B", &query("a.b"), "$1-x").unwrap();
    assert_eq!((out.as_str(), n), ("$1-x axb $1-x", 2));
    let (out, n) = replace_in_text("a.b A.B", &SearchQuery { case_sensitive: true, ..query("a.b") }, "z").unwrap();
    assert_eq!((out.as_str(), n), ("z A.B", 1));
}

#[test]
fn replace_regex_groups() {
    let q = regex(r"(\w+)\s*=\s*(?P<value>\d+)");
    let (out, n) = replace_in_text("x = 1; yy=22;", &q, "${value} => $1 ($$)").unwrap();
    assert_eq!((out.as_str(), n), ("1 => x ($); 22 => yy ($);", 2));
    let (out, _) = replace_in_text("ab", &regex("(a)(b)"), "$2$1${1}x").unwrap();
    assert_eq!(out, "baax");
}

#[test]
fn replace_escapes() {
    let (out, n) = replace_in_text("a,b,c", &regex(","), r"\n").unwrap();
    assert_eq!((out.as_str(), n), ("a\nb\nc", 2));
    let (out, _) = replace_in_text("a,b", &regex(","), r"\t\$\\").unwrap();
    assert_eq!(out, "a\t$\\b");
    // Literal queries never interpret escapes.
    let (out, _) = replace_in_text("a,b", &query(","), r"\n").unwrap();
    assert_eq!(out, r"a\nb");
}

#[test]
fn replace_whole_word_and_case() {
    let q = SearchQuery { whole_word: true, ..query("foo") };
    let (out, n) = replace_in_text("foo foobar Foo (foo)", &q, "bar").unwrap();
    assert_eq!((out.as_str(), n), ("bar foobar bar (bar)", 3));
}

#[test]
fn replace_is_line_oriented_unless_multi_line() {
    // `\s` must not cross lines, exactly as in search.
    let (out, n) = replace_in_text("a \nb", &regex(r"a\s+"), "X").unwrap();
    assert_eq!((out.as_str(), n), ("X\nb", 1));
    let (out, n) = replace_in_text("foo\n  bar\nfoo\nbaz", &regex(r"foo\n\s*bar"), "joined").unwrap();
    assert_eq!((out.as_str(), n), ("joined\nfoo\nbaz", 1));
    let (out, n) = replace_in_text("l1\nl2\r\nl3", &regex("^"), "> ").unwrap();
    assert_eq!((out.as_str(), n), ("> l1\n> l2\r\n> l3", 3));
    let (out, n) = replace_in_text("l1\r\nl2", &regex("$"), ";").unwrap();
    assert_eq!((out.as_str(), n), ("l1;\r\nl2;", 2));
}

#[test]
fn replace_unicode_and_empty() {
    let (out, n) = replace_in_text("中文 😀 中文", &query("中文"), "zh").unwrap();
    assert_eq!((out.as_str(), n), ("zh 😀 zh", 2));
    let (out, n) = replace_in_text("😀😀", &regex("x*"), "-").unwrap();
    assert_eq!((out.as_str(), n), ("-😀-😀-", 3));
    let (out, n) = replace_in_text("abc", &query(""), "-").unwrap();
    assert_eq!((out.as_str(), n), ("abc", 0));
    assert_eq!(replace_in_text("abc", &regex("("), "").unwrap_err().kind, ErrorKind::InvalidInput);
}

#[test]
fn replace_matches_search_count() {
    let text = "foo Foo fooFoo foo_bar\nbar foo\n";
    for q in [query("foo"), SearchQuery { whole_word: true, ..query("foo") }, regex("f[o]+")] {
        let p = project(&[("a.txt", text.as_bytes())]);
        let (_, summary) = run(p.path(), &q);
        let (_, n) = replace_in_text(text, &q, "x").unwrap();
        assert_eq!(summary.matches, n, "{q:?}");
    }
}

/// `OPENIDEA_SEARCH_BENCH=/path/to/repo PATTERN cargo test --release -- --ignored bench`
#[test]
#[ignore]
fn bench_large_tree() {
    let Ok(root) = std::env::var("OPENIDEA_SEARCH_BENCH") else { return };
    let pattern = std::env::var("OPENIDEA_SEARCH_PATTERN").unwrap_or_else(|_| "fn main".into());
    let q = SearchQuery { max_matches: u32::MAX, is_regex: true, case_sensitive: true, ..query(&pattern) };
    if let Ok(dump) = std::env::var("OPENIDEA_SEARCH_DUMP") {
        let (files, _) = run_with(Path::new(&root), &q, &|_| None, &CancellationToken::new());
        let list: Vec<_> = files.iter().map(|f| f.path.display().to_string()).collect();
        std::fs::write(dump, list.join("\n") + "\n").unwrap();
    }
    for _ in 0..3 {
        let (_, s) = run_with(Path::new(&root), &q, &|_| None, &CancellationToken::new());
        eprintln!("{} files, {} matches in {} ms", s.files, s.matches, s.elapsed_ms);
    }
}

#[test]
fn file_set_scope_applies_the_path_filter() {
    let p = project(&[
        ("src/main/java/App.java", b"needle\n"),
        ("src/test/java/AppTest.java", b"needle\n"),
        ("README.md", b"needle\n"),
    ]);
    let q = SearchQuery { scope: SearchScope::FileSet { set: ide_search::ProjectFileSet::Test }, ..query("needle") };
    let out = Mutex::new(Vec::new());
    let keep = |rel: &str| rel.starts_with("src/test/");
    ide_search::search_filtered(p.path(), &q, Some(&keep), &|_| None, &CancellationToken::new(), &|f| {
        out.lock().unwrap().push(f.rel_path)
    })
    .unwrap();
    assert_eq!(out.into_inner().unwrap(), vec!["src/test/java/AppTest.java"]);
    // Without a filter the file set walks the whole project.
    let (all, _) = run(p.path(), &q);
    assert_eq!(paths(&all), vec!["README.md", "src/main/java/App.java", "src/test/java/AppTest.java"]);
}

/// Test classifier: `//` to end of line is a comment, `"…"` a string (only in `.rs` files).
fn toy_literals(path: &Path, text: &str) -> Option<Vec<ide_search::LiteralRange>> {
    use ide_search::{LiteralKind, LiteralRange};
    if path.extension().is_none_or(|e| e != "rs") {
        return None;
    }
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"//") {
            let end = memchr_newline(bytes, i);
            out.push(LiteralRange { start: i, end, kind: LiteralKind::Comment });
            i = end;
        } else if bytes[i] == b'"' {
            let end = bytes[i + 1..].iter().position(|&b| b == b'"').map_or(bytes.len(), |p| i + p + 2);
            out.push(LiteralRange { start: i, end, kind: LiteralKind::String });
            i = end;
        } else {
            i += 1;
        }
    }
    Some(out)
}

fn memchr_newline(bytes: &[u8], from: usize) -> usize {
    bytes[from..].iter().position(|&b| b == b'\n').map_or(bytes.len(), |p| from + p)
}

/// `(rel_path, line, ranges)` of every matched line.
type Row = (String, u32, Vec<(u32, u32)>);

fn run_context(root: &Path, context: ide_search::SearchContext) -> Vec<Row> {
    let out = Mutex::new(Vec::new());
    let q = SearchQuery { context, ..query("foo") };
    ide_search::search_in_context(root, &q, None, Some(&toy_literals), &|_| None, &CancellationToken::new(), &|f| {
        out.lock().unwrap().push(f)
    })
    .unwrap();
    let mut rows: Vec<_> = out
        .into_inner()
        .unwrap()
        .into_iter()
        .flat_map(|f| f.matches.into_iter().map(move |m| (f.rel_path.clone(), m.line, m.ranges)))
        .collect();
    rows.sort();
    rows
}

#[test]
fn search_context_filters_comments_and_strings() {
    use ide_search::SearchContext as C;
    let p = project(&[("a.rs", b"foo(\"foo\"); // foo\nfoo\n"), ("b.txt", b"foo // foo\n")]);
    let rows = |c| run_context(p.path(), c);
    let s = |r: &str, l: u32, ranges: &[(u32, u32)]| (r.to_owned(), l, ranges.to_vec());
    assert_eq!(
        rows(C::Any),
        vec![s("a.rs", 0, &[(0, 3), (5, 8), (15, 18)]), s("a.rs", 1, &[(0, 3)]), s("b.txt", 0, &[(0, 3), (7, 10)])]
    );
    assert_eq!(rows(C::InComments), vec![s("a.rs", 0, &[(15, 18)])]);
    assert_eq!(rows(C::InStringLiterals), vec![s("a.rs", 0, &[(5, 8)])]);
    // Files without a syntax tree have no comments or strings.
    assert_eq!(
        rows(C::ExceptComments),
        vec![s("a.rs", 0, &[(0, 3), (5, 8)]), s("a.rs", 1, &[(0, 3)]), s("b.txt", 0, &[(0, 3), (7, 10)])]
    );
    assert_eq!(
        rows(C::ExceptCommentsAndStringLiterals),
        vec![s("a.rs", 0, &[(0, 3)]), s("a.rs", 1, &[(0, 3)]), s("b.txt", 0, &[(0, 3), (7, 10)])]
    );
}

#[test]
fn archives_are_skipped() {
    // A stored (uncompressed) zip entry would otherwise match before the first NUL byte.
    let p = project(&[("lib/needle.jar", b"needle in a jar"), ("docs.zip", b"needle"), ("src/a.txt", b"needle\n")]);
    let (views, _) = run(p.path(), &query("needle"));
    assert_eq!(paths(&views), ["src/a.txt"]);
}

#[test]
fn a_nested_repository_is_not_hidden_by_the_outer_repositorys_gitignore() {
    // parent/.git, parent/projects/.gitignore ignores everything, parent/projects/nested is its own repository.
    let p = project(&[
        ("projects/.gitignore", b"*\n!.gitignore\n"),
        ("projects/nested/search-test.txt", b"somesss\n"),
        ("projects/nested/src/main.txt", b"somesss\n"),
        ("projects/nested/.gitignore", b"logs/\n"),
        ("projects/nested/logs/debug.txt", b"somesss\n"),
    ]);
    std::fs::create_dir(p.path().join(".git")).unwrap();
    std::fs::create_dir(p.path().join("projects/nested/.git")).unwrap();
    let (views, _) = run(&p.path().join("projects/nested"), &query("somesss"));
    assert_eq!(
        paths(&views),
        ["search-test.txt", "src/main.txt"],
        "the nested repository's own .gitignore still applies"
    );
}

#[test]
fn a_project_inside_a_repository_keeps_the_repositorys_gitignore() {
    let p = project(&[(".gitignore", b"build/\n"), ("app/build/out.txt", b"hit\n"), ("app/src/a.txt", b"hit\n")]);
    std::fs::create_dir(p.path().join(".git")).unwrap();
    let (views, _) = run(&p.path().join("app"), &query("hit"));
    assert_eq!(paths(&views), ["src/a.txt"]);
}
