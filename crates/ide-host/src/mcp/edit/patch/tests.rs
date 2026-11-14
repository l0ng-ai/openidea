//! Parser and engine tests, including JetBrains' `PatchApplyEngineTest` cases.

use super::*;

fn update(ops: &[FileOp]) -> &[Hunk] {
    match &ops[0] {
        FileOp::Update { hunks, .. } => hunks,
        other => panic!("not an update: {other:?}"),
    }
}

fn apply_patch(text: &str, patch: &str) -> Result<String, String> {
    let ops = parse(patch)?;
    apply(text, update(&ops)).map(|a| a.text)
}

fn patch(lines: &[&str]) -> String {
    lines.iter().map(|l| format!("{l}\n")).collect()
}

fn hunk(lines: &[(char, &str)], at_eof: bool) -> Hunk {
    let lines = lines
        .iter()
        .map(|&(p, t)| match p {
            '-' => Line::Remove(t.into()),
            '+' => Line::Add(t.into()),
            _ => Line::Context(t.into()),
        })
        .collect();
    Hunk { lines, at_eof, ..Hunk::default() }
}

// --- Codex format -------------------------------------------------------

#[test]
fn parses_every_codex_operation() {
    let ops = parse(
        "*** Begin Patch\n*** Add File: new.txt\n+one\n+two\n*** Delete File: old.txt\n*** Update File: a.rs\n\
*** Move to: b.rs\n@@ fn main\n ctx\n-old\n+new\n*** End Patch\n",
    )
    .unwrap();
    assert_eq!(
        ops,
        vec![
            FileOp::Add { path: "new.txt".into(), text: "one\ntwo\n".into() },
            FileOp::Delete { path: "old.txt".into() },
            FileOp::Update {
                path: "a.rs".into(),
                move_to: Some("b.rs".into()),
                hunks: vec![Hunk {
                    anchors: vec!["fn main".into()],
                    lines: vec![Line::Context("ctx".into()), Line::Remove("old".into()), Line::Add("new".into())],
                    ..Hunk::default()
                }],
                or: vec![],
            },
        ]
    );
}

#[test]
fn codex_tolerates_wrappers_crlf_and_blank_separators() {
    let ops = parse(
        "apply_patch <<'EOF'\r\n*** Begin Patch\r\n*** Add File: x\r\n+a\r\n+\r\n\r\n*** Update File: y\r\n-a\r\n+b\r\n\r\n*** End Patch\r\nEOF",
    )
    .unwrap();
    assert_eq!(ops[0], FileOp::Add { path: "x".into(), text: "a\n\n".into() });
    assert_eq!(update(&ops[1..])[0].lines, vec![Line::Remove("a".into()), Line::Add("b".into())]);
    // JetBrains: a heredoc around the patch.
    let ops = parse(&patch(&["<<EOF", "*** Begin Patch", "*** Add File: notes.txt", "+alpha", "*** End Patch", "EOF"]))
        .unwrap();
    assert_eq!(ops, vec![FileOp::Add { path: "notes.txt".into(), text: "alpha\n".into() }]);
}

#[test]
fn codex_empty_add_and_move_only() {
    let ops = parse("*** Begin Patch\n*** Add File: e\n*** Update File: a\n*** Move to: b\n*** End Patch").unwrap();
    assert_eq!(ops[0], FileOp::Add { path: "e".into(), text: String::new() });
    assert_eq!(ops[1], FileOp::Update { path: "a".into(), move_to: Some("b".into()), hunks: vec![], or: vec![] });
}

/// JetBrains `PatchApplyEngineTest`: the parse errors.
#[test]
fn codex_errors() {
    let fails = |lines: &[&str], expected: &str| {
        let e = parse(&patch(lines)).unwrap_err();
        assert!(e.contains(expected), "expected `{expected}` in: {e}");
    };
    fails(&["oops"], "patch must include *** Begin Patch");
    fails(&["*** Begin Patch", "*** Add File: notes.txt", "+alpha"], "patch must include *** End Patch");
    fails(&["*** Begin Patch", "*** End Patch"], "patch did not contain any operations");
    fails(&["*** Begin Patch", "oops", "*** End Patch"], "Unexpected patch line: oops");
    fails(&["*** Begin Patch", "*** Add File:   ", "*** End Patch"], "Add File requires a path");
    fails(
        &["*** Begin Patch", "*** Add File: notes.txt", "alpha", "*** End Patch"],
        "Add File lines must start with +",
    );
    fails(
        &["*** Begin Patch", "*** Add File: notes.txt", "+alpha", "beta", "*** End Patch"],
        "Add File lines must start with + (line 4: `beta`)",
    );
    fails(&["*** Begin Patch", "*** Delete File:   ", "*** End Patch"], "Delete File requires a path");
    fails(&["*** Begin Patch", "*** Update File:   ", "*** End Patch"], "Update File requires a path");
    fails(
        &["*** Begin Patch", "*** Update File: s.txt", "*** Move to:   ", "*** End Patch"],
        "Move to requires a path",
    );
    fails(&["*** Begin Patch", "*** Update File: s.txt", "*** End Patch"], "Update File requires at least one hunk");
    fails(&["*** Begin Patch", "*** Update File: s.txt", "oops", "*** End Patch"], "Expected @@ hunk header");
    fails(
        &["*** Begin Patch", "*** Update File: s.txt", " alpha", "-beta", "+gamma", "oops", "*** End Patch"],
        "Expected @@ hunk header",
    );
    fails(
        &["*** Begin Patch", "*** Update File: s.txt", "@@ def sample()", "oops", "*** End Patch"],
        "Hunk lines must start with space, +, or -",
    );
    fails(&["*** Begin Patch", "*** Update File: s.txt", "@@", "*** End Patch"], "Empty hunk in Update File");
    fails(
        &["*** Begin Patch", "*** Update File: s.txt", "@@", "## Goals", "*** End Patch"],
        "Strict @@ pair hunk requires second @@ delimiter",
    );
    fails(
        &["*** Begin Patch", "*** Delete File: bad\\npath.txt", "*** End Patch"],
        "Delete File path contains control",
    );
    fails(
        &["*** Begin Patch", "*** Add File: bad\\npath.txt", "+alpha", "*** End Patch"],
        "Add File path contains control characters or escape sequences",
    );
    fails(&["*** Begin Patch", "*** Update File: bad\\npath.txt", "*** End Patch"], "Update File path contains");
    fails(
        &["*** Begin Patch", "*** Update File: s.txt", "*** Move to: bad\\npath.txt", "*** End Patch"],
        "Move to path contains",
    );
    fails(&["*** Begin Patch", "*** Update File: a", "-x", "*** End of File", "-y", "*** End Patch"], "Expected @@");
}

#[test]
fn codex_hunks_split_on_markers_and_stack_anchors() {
    let ops = parse(
        "*** Begin Patch\n*** Update File: a\n@@ class A\n@@ def f():\n-x\n+y\n@@\n-p\n+q\n*** End of File\n*** End Patch",
    )
    .unwrap();
    let hunks = update(&ops);
    assert_eq!(hunks.len(), 2);
    assert_eq!(hunks[0].anchors, vec!["class A".to_owned(), "def f():".to_owned()]);
    assert!(!hunks[0].at_eof && hunks[1].at_eof);
    assert!(hunks[1].anchors.is_empty());
}

#[test]
fn codex_headers_with_line_numbers_are_hints_not_anchors() {
    for header in ["@@@ -48,6 +48,7 @@@", "@@ -48,6 +48,7 @@", "@@ -48,6 +48,7 @@ fn sample()"] {
        let ops = parse(&patch(&["*** Begin Patch", "*** Update File: s", header, " a", "-b", "+c", "*** End Patch"]))
            .unwrap();
        let h = &update(&ops)[0];
        assert!(h.anchors.is_empty(), "{header}: {:?}", h.anchors);
        assert_eq!(h.old_start, Some(48), "{header}");
    }
    let ops =
        parse(&patch(&["*** Begin Patch", "*** Update File: s", "@@ def sample()", " a", "*** End Patch"])).unwrap();
    assert_eq!(update(&ops)[0].anchors, vec!["def sample()".to_owned()]);
    // JetBrains `applyHunks works with unified-diff style hunk headers`.
    let p = patch(&[
        "*** Begin Patch",
        "*** Update File: s",
        "@@ -1,3 +1,4 @@",
        " alpha",
        "-beta",
        "+BETA",
        " gamma",
        "+delta",
        "*** End Patch",
    ]);
    assert_eq!(apply_patch("alpha\nbeta\ngamma\n", &p).unwrap(), "alpha\nBETA\ngamma\ndelta\n");
}

#[test]
fn strict_pair_hunks() {
    let p = patch(&[
        "*** Begin Patch",
        "*** Update File: s",
        "@@",
        "## Goals",
        "- Keep old wording",
        "@@",
        "## Goals",
        "- Keep new wording",
        "*** End Patch",
    ]);
    let ops = parse(&p).unwrap();
    let h = &update(&ops)[0];
    assert!(h.anchors.is_empty());
    assert_eq!(
        h.lines,
        vec![
            Line::Remove("## Goals".into()),
            Line::Remove("- Keep old wording".into()),
            Line::Add("## Goals".into()),
            Line::Add("- Keep new wording".into()),
        ]
    );
    assert_eq!(apply_patch("# T\n## Goals\n- Keep old wording\n", &p).unwrap(), "# T\n## Goals\n- Keep new wording\n");
}

#[test]
fn applies_codex_hunks_with_anchors() {
    let text = "class A:\n    def f():\n        return 1\nclass B:\n    def f():\n        return 1\n";
    let patch = "*** Begin Patch\n*** Update File: a.py\n@@ class B:\n     def f():\n-        return 1\n+        return 2\n*** End Patch";
    assert_eq!(
        apply_patch(text, patch).unwrap(),
        "class A:\n    def f():\n        return 1\nclass B:\n    def f():\n        return 2\n"
    );
}

#[test]
fn applies_several_hunks_in_order() {
    let text = "a\nb\nc\nd\ne\nf\n";
    let patch = "*** Begin Patch\n*** Update File: x\n@@\n a\n-b\n+B\n@@\n e\n-f\n+F\n+G\n*** End Patch";
    assert_eq!(apply_patch(text, patch).unwrap(), "a\nB\nc\nd\ne\nF\nG\n");
}

#[test]
fn same_lines_twice_match_in_order() {
    let text = "x\ny\nx\ny\n";
    let patch = "*** Begin Patch\n*** Update File: f\n@@\n-x\n+1\n@@\n-x\n+2\n*** End Patch";
    assert_eq!(apply_patch(text, patch).unwrap(), "1\ny\n2\ny\n");
}

#[test]
fn end_of_file_hunks_must_end_the_file() {
    let text = "end\nmid\nend\n";
    let patch = "*** Begin Patch\n*** Update File: f\n@@\n-end\n+END\n*** End of File\n*** End Patch";
    assert_eq!(apply_patch(text, patch).unwrap(), "end\nmid\nEND\n");
    let beta = hunk(&[('-', "beta"), ('+', "BETA")], true);
    assert_eq!(apply("alpha\nbeta\n", std::slice::from_ref(&beta)).unwrap().text, "alpha\nBETA\n");
    let e = apply("alpha\nbeta\ngamma\n", &[beta]).unwrap_err();
    assert!(e.starts_with("Hunk context not found") && e.contains("do not end the file"), "{e}");
}

#[test]
fn hunks_out_of_order_are_found_from_the_top() {
    let hunks = [hunk(&[('-', "one"), ('+', "ONE")], true), hunk(&[('-', "two"), ('+', "TWO")], false)];
    assert_eq!(apply("one\ntwo\nthree\none\n", &hunks).unwrap().text, "one\nTWO\nthree\nONE\n");
    let text = "fn a() {\n    one();\n    two();\n}\n";
    let p =
        "*** Begin Patch\n*** Update File: f\n@@\n-    two();\n+    2();\n@@\n-    one();\n+    1();\n*** End Patch";
    assert_eq!(apply_patch(text, p).unwrap(), "fn a() {\n    1();\n    2();\n}\n");
}

#[test]
fn many_repeated_hunks_apply_deterministically() {
    let hunks: Vec<Hunk> = (0..80).map(|i| hunk(&[('-', "alpha"), ('+', &format!("alpha-{i}"))], false)).collect();
    let text = "alpha\n".repeat(600);
    let expected: String = (0..80).map(|i| format!("alpha-{i}\n")).collect::<String>() + &"alpha\n".repeat(520);
    assert_eq!(apply(&text, &hunks).unwrap().text, expected);
}

#[test]
fn accepts_the_anchor_repeated_as_context() {
    let text = "package greet\n\nfunc prefix() string {\n\treturn \"Merhaba, \"\n}\n";
    let patch = "*** Begin Patch\n*** Update File: f\n@@ func prefix() string {\n func prefix() string {\n-\treturn \"Merhaba, \"\n+\treturn \"Selam, \"\n }\n*** End Patch";
    assert_eq!(apply_patch(text, patch).unwrap(), "package greet\n\nfunc prefix() string {\n\treturn \"Selam, \"\n}\n");
}

#[test]
fn pure_additions_go_after_the_anchor_or_at_the_end() {
    let text = "fn a() {}\nfn b() {}\n";
    let after = "*** Begin Patch\n*** Update File: f\n@@ fn a() {}\n+fn a2() {}\n*** End Patch";
    assert_eq!(apply_patch(text, after).unwrap(), "fn a() {}\nfn a2() {}\nfn b() {}\n");
    let end = "*** Begin Patch\n*** Update File: f\n@@\n+fn c() {}\n*** End Patch";
    assert_eq!(apply_patch(text, end).unwrap(), "fn a() {}\nfn b() {}\nfn c() {}\n");
}

#[test]
fn fuzz_levels_are_tried_in_order_and_reported() {
    let text = "fn main() {   \n    let x = 1;\n}\n";
    let ops =
        parse("*** Begin Patch\n*** Update File: f\n@@\n fn main() {\n-    let x = 1;\n+    let x = 2;\n*** End Patch")
            .unwrap();
    let a = apply(text, update(&ops)).unwrap();
    assert_eq!(a.text, "fn main() {   \n    let x = 2;\n}\n");
    assert_eq!(a.fuzzy, vec![(1, Fuzz::TrailingWhitespace)]);
    let ops = parse("*** Begin Patch\n*** Update File: f\n@@\n-let x = 1;\n+    let y = 1;\n*** End Patch").unwrap();
    let a = apply(text, update(&ops)).unwrap();
    assert_eq!(a.text, "fn main() {   \n    let y = 1;\n}\n");
    assert_eq!(a.fuzzy, vec![(1, Fuzz::Whitespace)]);

    // JetBrains: typographic punctuation, exact matches first.
    let typographic = "import asyncio  # local import \u{2013} avoids top\u{2011}level dep";
    let ascii = "import asyncio  # local import - avoids top-level dep";
    let a =
        apply(&format!("{typographic}\n"), &[hunk(&[('-', ascii), ('+', "import asyncio  # HELLO")], false)]).unwrap();
    assert_eq!(a.text, "import asyncio  # HELLO\n");
    assert_eq!(a.fuzzy, vec![(1, Fuzz::Punctuation)]);
    let both = [hunk(&[('-', ascii), ('+', "# FIRST")], false), hunk(&[('-', ascii), ('+', "# SECOND")], false)];
    let text = format!("first\n{typographic}\n{typographic}\n");
    assert_eq!(apply(&text, &both).unwrap().text, "first\n# FIRST\n# SECOND\n");
    let text = format!("first\n{typographic}\n{ascii}\n");
    let exact = apply(&text, &[hunk(&[('-', ascii), ('+', "# EXACT")], false)]).unwrap();
    assert_eq!(exact.text, format!("first\n{typographic}\n# EXACT\n"));
}

#[test]
fn a_trailing_blank_context_line_is_optional() {
    let text = "a\nb";
    let patch = "*** Begin Patch\n*** Update File: f\n@@\n-b\n+c\n \n*** End Patch";
    assert_eq!(apply_patch(text, patch).unwrap(), "a\nc");
}

#[test]
fn keeps_a_missing_final_newline_and_handles_empty_files() {
    assert_eq!(apply_patch("a\nb", "*** Begin Patch\n*** Update File: f\n-b\n+c\n*** End Patch").unwrap(), "a\nc");
    assert_eq!(apply_patch("", "*** Begin Patch\n*** Update File: f\n+x\n*** End Patch").unwrap(), "x\n");
    assert_eq!(apply_patch("a\n", "*** Begin Patch\n*** Update File: f\n-a\n*** End Patch").unwrap(), "");
    let h = hunk(&[('-', "alpha"), ('+', "alpha2"), (' ', "beta")], false);
    assert_eq!(apply("alpha   \nbeta\n", &[h]).unwrap().text, "alpha2\nbeta\n");
}

#[test]
fn reports_where_a_hunk_went_wrong() {
    let text = "fn a() {\n    one();\n    two();\n}\n";
    let patch =
        "*** Begin Patch\n*** Update File: f\n@@\n fn a() {\n     one();\n-    three();\n+    four();\n*** End Patch";
    let e = apply_patch(text, patch).unwrap_err();
    assert!(e.starts_with("Hunk context not found: hunk 1 does not apply"), "{e}");
    assert!(e.contains("  fn a() {\n      one();\n      three();\n"), "{e}");
    assert!(e.contains("Closest match at line 1: line 3 is `    two();`, but the patch expects `    three();`"), "{e}");
    let e = apply_patch(text, "*** Begin Patch\n*** Update File: f\n@@ fn zzz\n-x\n*** End Patch").unwrap_err();
    assert!(e.contains("hunk 1 (@@ fn zzz)") && e.contains("`fn zzz`"), "{e}");
    let e = apply_patch(text, "*** Begin Patch\n*** Update File: f\n-nothing\n*** End Patch").unwrap_err();
    assert!(e.contains("No line of them"), "{e}");
    let e = apply_patch(text, "*** Begin Patch\n*** Update File: f\n-two\n+three\n*** End Patch").unwrap_err();
    assert!(e.contains("Line 3 contains `two` but is `    two();`: patch lines must be whole lines"), "{e}");
}

// --- unified diffs ------------------------------------------------------

const GIT: &str = "diff --git a/src/lib.rs b/src/lib.rs
index 3b18e51..a9e0c2f 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,3 +1,3 @@ mod x;
 fn a() {}
-fn b() {}
+fn b() { todo!() }
 fn c() {}
@@ -10,2 +10,3 @@
 fn j() {}
+fn k() {}
 fn l() {}
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old name.txt b/new name.txt
similarity index 90%
rename from old name.txt
rename to new name.txt
--- a/old name.txt
+++ b/new name.txt
@@ -1 +1 @@
-x
+y
";

#[test]
fn parses_git_diffs() {
    let ops = parse(GIT).unwrap();
    assert_eq!(ops.len(), 4);
    match &ops[0] {
        FileOp::Update { path, move_to: None, hunks, or } => {
            assert_eq!(path, "src/lib.rs");
            assert!(or.is_empty(), "{or:?}");
            assert_eq!(hunks.len(), 2);
            assert_eq!(hunks[0].old_start, Some(1));
            assert_eq!(hunks[1].lines.len(), 3);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(ops[1], FileOp::Add { path: "new.txt".into(), text: "hello\nworld\n".into() });
    assert_eq!(ops[2], FileOp::Delete { path: "gone.txt".into() });
    assert!(matches!(&ops[3], FileOp::Update { path, move_to: Some(to), .. }
        if path == "old name.txt" && to == "new name.txt"));
}

#[test]
fn parses_git_diffs_inside_begin_patch() {
    let ops = parse(&patch(&[
        "*** Begin Patch",
        "diff --git a/s.txt b/s.txt",
        "--- a/s.txt",
        "+++ b/s.txt",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "*** End Patch",
    ]))
    .unwrap();
    assert!(
        matches!(&ops[..], [FileOp::Update { path, move_to: None, hunks, .. }] if path == "s.txt" && hunks.len() == 1)
    );
    // `--- x` removing a `-- x` line keeps a Codex patch a Codex patch.
    let ops =
        parse("*** Begin Patch\n*** Update File: q.sql\n@@\n--- old comment\n+-- new comment\n*** End Patch").unwrap();
    assert_eq!(update(&ops)[0].lines, vec![Line::Remove("-- old comment".into()), Line::Add("-- new comment".into())]);
}

#[test]
fn parses_plain_unified_diffs_and_pure_renames() {
    let ops =
        parse("--- a.txt\t2024-01-01 10:00:00\n+++ a.txt\t2024-01-02 10:00:00\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n").unwrap();
    assert!(
        matches!(&ops[0], FileOp::Update { path, move_to: None, hunks, .. } if path == "a.txt" && hunks.len() == 1)
    );
    // Differently named sides are not a move: the `+++` path, else the others.
    let ops = parse("--- a.txt.orig\n+++ a.txt\n@@ -1 +1 @@\n-a\n+b\n").unwrap();
    assert!(matches!(&ops[0], FileOp::Update { path, move_to: None, or, .. }
        if path == "a.txt" && or == &["a.txt.orig"]));
    let ops = parse(
        "diff -ru old/src/a.txt new/src/a.txt\n--- old/src/a.txt\t2024-01-01\n+++ new/src/a.txt\t2024-01-02\n@@ -1 +1 @@\n-a\n+b\n",
    )
    .unwrap();
    assert!(matches!(&ops[0], FileOp::Update { path, move_to: None, or, .. }
        if path == "new/src/a.txt" && or == &["old/src/a.txt", "src/a.txt"]));
    let ops = parse("diff --git a/x.rs b/y/x.rs\nsimilarity index 100%\nrename from x.rs\nrename to y/x.rs\n").unwrap();
    assert_eq!(
        ops[0],
        FileOp::Update { path: "x.rs".into(), move_to: Some("y/x.rs".into()), hunks: vec![], or: vec![] }
    );
    let ops = parse("diff --git a/e b/e\nnew file mode 100644\nindex 0000000..e69de29\n").unwrap();
    assert_eq!(ops[0], FileOp::Add { path: "e".into(), text: String::new() });
    let ops = parse("diff --git \"a/sp ace\" \"b/sp ace\"\ndeleted file mode 100644\n").unwrap();
    assert_eq!(ops[0], FileOp::Delete { path: "sp ace".into() });
}

#[test]
fn unified_counts_are_tolerated() {
    // Counts too large: the next header ends the hunk.
    let ops = parse("--- a/f\n+++ b/f\n@@ -1,9 +1,9 @@\n-a\n+b\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-c\n+d\n").unwrap();
    assert_eq!(ops.len(), 2);
    assert_eq!(update(&ops)[0].lines.len(), 2);
    // Counts too small: following hunk lines still belong to it.
    let ops = parse("--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n+b\n c\n").unwrap();
    assert_eq!(update(&ops)[0].lines.len(), 3);
    // A bare `@@` reads to the next header; empty lines are empty context.
    let ops = parse("--- a/f\n+++ b/f\n@@\n x\n\n-y\n+z\n\n").unwrap();
    assert_eq!(
        update(&ops)[0].lines,
        vec![Line::Context("x".into()), Line::Context(String::new()), Line::Remove("y".into()), Line::Add("z".into())]
    );
    // `git format-patch` signature.
    let ops = parse("Subject: x\n---\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n-- \n2.43.0\n").unwrap();
    assert_eq!(ops.len(), 1);
    // `*** End of File` inside a unified hunk.
    let ops = parse("--- a/f\n+++ b/f\n@@\n-a\n+b\n*** End of File\n").unwrap();
    assert!(update(&ops)[0].at_eof);
}

#[test]
fn unified_errors() {
    assert!(parse("@@ -1 +1 @@\n-a\n+b\n").unwrap_err().contains("patch must include *** Begin Patch"));
    assert!(parse("--- a/f\n+++ b/f\n@@ -x +y @@\n-a\n").unwrap_err().contains("cannot read"));
    let e = parse("diff --git a/f b/f\nBinary files a/f and b/f differ\n").unwrap_err();
    assert!(e.contains("Binary git patch is not supported"), "{e}");
    assert!(parse("diff --git a/f b/f\nindex 1..2\n").unwrap_err().contains("no changes"));
    assert!(parse("--- /dev/null\n+++ b/n\n@@ -1 +1 @@\n x\n").unwrap_err().contains("new file"));
    let e = parse("--- a/f\n+++ b/f\n@@ -1 +1 @@\nzzz\n").unwrap_err();
    assert!(e.contains("Hunk lines must start with space, +, or - (line 4: `zzz`)"), "{e}");
}

#[test]
fn applies_unified_hunks_near_their_line_numbers() {
    let text = "x\nsame\nx\nx\nx\nsame\nx\n";
    let ops = parse("--- a/f\n+++ b/f\n@@ -6,1 +6,1 @@\n-same\n+changed\n").unwrap();
    assert_eq!(apply(text, update(&ops)).unwrap().text, "x\nsame\nx\nx\nx\nchanged\nx\n");
    // Wrong line numbers still apply where the context is.
    let ops = parse("--- a/f\n+++ b/f\n@@ -40,2 +40,2 @@\n x\n-same\n+changed\n").unwrap();
    assert_eq!(apply(text, update(&ops)).unwrap().text, "x\nsame\nx\nx\nx\nchanged\nx\n");
    // Insertion after line 2 (`-2,0`).
    let ops = parse("--- a/f\n+++ b/f\n@@ -2,0 +3,1 @@\n+new\n").unwrap();
    assert_eq!(apply(text, update(&ops)).unwrap().text, "x\nsame\nnew\nx\nx\nx\nsame\nx\n");
    // Later line numbers shift by what earlier hunks added.
    let ops = parse("--- a/f\n+++ b/f\n@@ -0,0 +1,2 @@\n+n1\n+n2\n@@ -6,1 +8,1 @@\n-same\n+changed\n").unwrap();
    assert_eq!(apply(text, update(&ops)).unwrap().text, "n1\nn2\nx\nsame\nx\nx\nx\nchanged\nx\n");
}

#[test]
fn applies_the_git_example() {
    let text = "fn a() {}\nfn b() {}\nfn c() {}\nfn d() {}\nfn e() {}\nfn f() {}\nfn g() {}\nfn h() {}\nfn i() {}\nfn j() {}\nfn l() {}\n";
    let ops = parse(GIT).unwrap();
    let out = apply(text, update(&ops)).unwrap().text;
    assert_eq!(
        out,
        "fn a() {}\nfn b() { todo!() }\nfn c() {}\nfn d() {}\nfn e() {}\nfn f() {}\nfn g() {}\nfn h() {}\nfn i() {}\nfn j() {}\nfn k() {}\nfn l() {}\n"
    );
}

#[test]
fn no_newline_markers() {
    let add = parse("--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+x\n\\ No newline at end of file\n").unwrap();
    assert_eq!(add[0], FileOp::Add { path: "n".into(), text: "x".into() });
    // Adding the final newline.
    let ops = parse("--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n").unwrap();
    assert_eq!(apply("a\nb", update(&ops)).unwrap().text, "a\nb\n");
    // Removing it.
    let ops = parse("--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file\n").unwrap();
    assert_eq!(apply("a\nb\n", update(&ops)).unwrap().text, "a\nb");
}

#[test]
fn splits_git_paths() {
    assert_eq!(split_git_paths("a/x y b/x y"), (Some("x y".into()), Some("x y".into())));
    assert_eq!(split_git_paths("a/x b/y"), (Some("x".into()), Some("y".into())));
    assert_eq!(parse_range_header("@@ -3 +4,0 @@"), Some((3, 1, 0)));
    assert_eq!(parse_range_header("@@ -1,2 +1,3 @@ fn x"), Some((1, 2, 3)));
    assert_eq!(parse_range_header("@@@ -48,6 +48,7 @@@"), Some((48, 6, 7)));
    assert_eq!(parse_range_header("@@ fn x"), None);
    assert_eq!(unquote("\"a\\\"b\\\\c\""), "a\"b\\c");
}

#[test]
fn mode_changes_and_copies_do_not_fail_the_patch() {
    // A mode-only section is an update without hunks; the hunks of the others still apply.
    let diff = patch(&[
        "diff --git a/run.sh b/run.sh",
        "old mode 100644",
        "new mode 100755",
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-x",
        "+y",
    ]);
    let ops = parse(&diff).unwrap();
    assert_eq!(ops.len(), 2);
    assert_eq!(ops[0], FileOp::Update { path: "run.sh".into(), move_to: None, hunks: Vec::new(), or: Vec::new() });
    assert_eq!(update(&ops[1..]).len(), 1);

    // A mode change together with a rename is a move.
    let ops = parse("diff --git a/x b/y\nold mode 100644\nnew mode 100755\nrename from x\nrename to y\n").unwrap();
    assert!(matches!(&ops[0], FileOp::Update { move_to: Some(m), .. } if m == "y"));

    // A copy is skipped with a note.
    let diff = patch(&[
        "diff --git a/src/a.rs b/src/b.rs",
        "similarity index 90%",
        "copy from src/a.rs",
        "copy to src/b.rs",
        "--- a/src/a.rs",
        "+++ b/src/b.rs",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "diff --git a/c.txt b/c.txt",
        "--- a/c.txt",
        "+++ b/c.txt",
        "@@ -1 +1 @@",
        "-1",
        "+2",
    ]);
    let ops = parse(&diff).unwrap();
    assert_eq!(ops.len(), 2);
    match &ops[0] {
        FileOp::Skip { path, note } => {
            assert_eq!(path, "src/b.rs");
            assert!(note.contains("copy of src/a.rs to src/b.rs") && note.contains("not supported"), "{note}");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(ops[1].path(), "c.txt");
}
