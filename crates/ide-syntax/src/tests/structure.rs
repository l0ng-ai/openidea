use super::*;

#[test]
fn every_bundled_locals_query_compiles() {
    let syntax = Syntax::new();
    let mut failures = Vec::new();
    let mut covered = Vec::new();
    for grammar in Syntax::grammar_names() {
        let _ =
            syntax.with_parsed(&lang(grammar), "", &|| false, |p| match crate::locals::compile(grammar, p.language) {
                Some(Ok(())) => covered.push(grammar),
                Some(Err(e)) => failures.push(format!("{grammar}: {e}")),
                None => {}
            });
    }
    assert!(failures.is_empty(), "invalid locals queries:\n{}", failures.join("\n"));
    for g in [
        "java",
        "kotlin",
        "python",
        "javascript",
        "typescript",
        "tsx",
        "rust",
        "go",
        "c",
        "cpp",
        "csharp",
        "ruby",
        "php",
        "swift",
        "scala",
        "lua",
        "bash",
        "dart",
        "elixir",
        "zig",
        "haskell",
    ] {
        assert!(covered.contains(&g), "no locals query for {g}");
    }
}

fn snap<'a>(l: &'a LanguageId, src: &'a str) -> Snapshot<'a> {
    Snapshot::text(l, src)
}

#[test]
fn node_at_reports_smallest_named_node_and_ancestors() {
    let src = "class A {\n  int f(int a) {\n    return foo(a + 1);\n  }\n}\n";
    let java = lang("java");
    let r = occ(src, "a", 2);
    let at = service().node_at(&snap(&java, src), r, &none()).unwrap().unwrap();
    assert_eq!(at.node.kind, "identifier");
    assert_eq!(at.node.range, r);
    assert_eq!(at.node.field.as_deref(), Some("left"));
    let kinds: Vec<&str> = at.ancestors.iter().map(|n| n.kind.as_str()).collect();
    assert_eq!(&kinds[..4], ["binary_expression", "argument_list", "method_invocation", "return_statement"]);
    assert_eq!(kinds.last(), Some(&"program"));
    // A range spanning two siblings yields their parent.
    let at = service().node_at(&snap(&java, src), span(src, "a + 1"), &none()).unwrap().unwrap();
    assert_eq!(at.node.kind, "binary_expression");
    assert!(!at.node.has_error);
}

#[test]
fn syntax_errors_find_missing_semicolons_and_garbage() {
    let rust = lang("rust");
    let src = "fn f() {\n    let z = 1\n    z\n}\n";
    let errs = service().syntax_errors(&snap(&rust, src), &none()).unwrap();
    assert_eq!(errs.errors.len(), 1, "{errs:?}");
    let e = &errs.errors[0];
    assert_eq!(e.kind, SyntaxErrorKind::Missing);
    assert_eq!(e.expected.as_deref(), Some(";"));
    assert_eq!(e.message, "missing `;`");
    assert_eq!(e.range, Range::point(Pos::new(1, 13)));

    let java = lang("java");
    let src = "class A {\n  void f() {\n    int x = 1 +;\n  }\n}\n";
    let errs = service().syntax_errors(&snap(&java, src), &none()).unwrap();
    assert!(!errs.errors.is_empty());
    assert!(errs.errors.iter().all(|e| e.range.start.line == 2), "{errs:?}");

    let ok = service().syntax_errors(&snap(&java, "class A {}"), &none()).unwrap();
    assert_eq!(ok, SyntaxErrors::default());
}

#[test]
fn expression_at_exact_enclosing_and_caret() {
    let java = lang("java");
    let src = "class A {\n  int f(int a, int b) {\n    int r = compute(a + b * 2, b);\n    return r;\n  }\n}\n";
    let s = snap(&java, src);
    // Exact selection (whitespace around it is ignored).
    let sel = span(src, "b * 2");
    let e =
        service().expression_at(&s, Range::new(Pos::new(sel.start.line, sel.start.col - 1), sel.end), &none()).unwrap();
    let expr = e.expression.clone().unwrap();
    assert!(e.exact);
    assert_eq!((expr.kind.as_str(), expr.range), ("binary_expression", sel));
    assert_eq!(e.statement.as_ref().unwrap().kind, "local_variable_declaration");
    assert_eq!(e.block.as_ref().unwrap().kind, "block");
    assert!(e.function_boundary.is_none());
    // Partial selection: the smallest enclosing expression, not exact.
    let e = service().expression_at(&s, span(src, "a + b"), &none()).unwrap();
    assert!(!e.exact);
    assert_eq!(e.expression.unwrap().range, span(src, "a + b * 2"));
    // Caret inside `compute`: candidates from the call outward up to the statement.
    let caret = occ(src, "a", 2).start;
    let e = service().expression_at(&s, Range::point(caret), &none()).unwrap();
    let kinds: Vec<&str> = e.candidates.iter().map(|c| c.kind.as_str()).collect();
    assert_eq!(kinds, ["identifier", "binary_expression", "method_invocation"]);
    // Names in declarations are not expressions.
    let e = service().expression_at(&s, occ(src, "r", 1), &none()).unwrap();
    assert!(e.expression.is_none(), "{e:?}");
}

#[test]
fn expression_at_flags_lambda_boundary_and_errors() {
    let ts = lang("typescript");
    let src = "function f(xs: number[]) {\n  const ys = xs.map((x) => x * 2 + 1);\n  return ys\n}\n";
    let e = service().expression_at(&snap(&ts, src), span(src, "x * 2"), &none()).unwrap();
    assert!(e.exact);
    assert_eq!(e.function_boundary.unwrap().kind, "arrow_function");
    assert_eq!(e.statement.unwrap().kind, "lexical_declaration");
    // Candidates stop at the lambda: hoisting out of it would break `x`.
    assert!(e.candidates.iter().all(|c| c.kind != "call_expression"), "{:?}", e.candidates);

    let java = lang("java");
    let src = "class A {\n  void f() {\n    int y = g(1) + 2\n    h(y);\n  }\n}\n";
    let e = service().expression_at(&snap(&java, src), span(src, "g(1)"), &none()).unwrap();
    assert!(e.exact);
    assert!(e.has_error);
}

#[test]
fn expression_at_across_languages() {
    let cases: &[(&str, &str, &str, &str)] = &[
        ("python", "def f(a):\n    return len(a) + 1\n", "len(a)", "call"),
        ("rust", "fn f(a: u32) -> u32 {\n    let b = a.pow(2) + 1;\n    b\n}\n", "a.pow(2)", "call_expression"),
        ("go", "package m\nfunc f(a int) int {\n\tb := g(a) + 1\n\treturn b\n}\n", "g(a)", "call_expression"),
        ("kotlin", "fun f(a: Int): Int {\n    val b = g(a) + 1\n    return b\n}\n", "g(a)", "call_expression"),
        ("swift", "func f(a: Int) -> Int {\n  let b = g(a) + 1\n  return b\n}\n", "g(a)", "call_expression"),
        (
            "scala",
            "object O {\n  def f(a: Int): Int = {\n    val b = g(a) + 1\n    b\n  }\n}\n",
            "g(a)",
            "call_expression",
        ),
        ("dart", "int f(int a) {\n  var b = g(a) + 1;\n  return b;\n}\n", "g(a)", "call_expression"),
        (
            "csharp",
            "class A {\n  int F(int a) {\n    var b = G(a) + 1;\n    return b;\n  }\n}\n",
            "G(a)",
            "invocation_expression",
        ),
        ("ruby", "def f(a)\n  b = g(a) + 1\n  b\nend\n", "g(a)", "call"),
        ("php", "<?php\nfunction f($a) {\n  $b = g($a) + 1;\n  return $b;\n}\n", "g($a)", "function_call_expression"),
        ("lua", "local function f(a)\n  local b = g(a) + 1\n  return b\nend\n", "g(a)", "function_call"),
        ("cpp", "int f(int a) {\n  int b = g(a) + 1;\n  return b;\n}\n", "g(a)", "call_expression"),
        ("zig", "fn f(a: u32) u32 {\n    const b = g(a) + 1;\n    return b;\n}\n", "g(a)", "call_expression"),
        ("elixir", "def f(a) do\n  b = g(a) + 1\n  b\nend\n", "g(a)", "call"),
    ];
    for (language, src, sel, kind) in cases {
        let l = lang(language);
        let e = service().expression_at(&snap(&l, src), span(src, sel), &none()).unwrap();
        let expr = e.expression.as_ref().unwrap_or_else(|| panic!("{language}: no expression for `{sel}`: {e:?}"));
        assert!(e.exact, "{language}: {e:?}");
        assert_eq!(expr.kind, *kind, "{language}");
        assert!(e.statement.is_some(), "{language}: no statement: {e:?}");
        assert!(e.block.is_some(), "{language}: no block");
    }
}

#[test]
fn identifiers_named_skips_comments_and_strings() {
    let ts = lang("typescript");
    let src = "// count is a comment\nconst count = 1; /* count */\nconst s = \"count\" + `${count} count`;\nobj.count(count);\n";
    let found = service().identifiers_named(&snap(&ts, src), "count", &none()).unwrap();
    let got: Vec<(Range, bool)> = found.iter().map(|o| (o.range, o.qualified)).collect();
    let want = vec![
        (Range::new(Pos::new(1, 6), Pos::new(1, 11)), false),
        (Range::new(Pos::new(2, 23), Pos::new(2, 28)), false),
        (Range::new(Pos::new(3, 4), Pos::new(3, 9)), true),
        (Range::new(Pos::new(3, 10), Pos::new(3, 15)), false),
    ];
    assert_eq!(got, want, "{found:?}");
    assert_eq!(found[2].kind, "property_identifier");
    // Words that merely contain the name are not occurrences.
    assert!(service().identifiers_named(&snap(&ts, "const counter = 1;"), "count", &none()).unwrap().is_empty());

    let py = lang("python");
    let src = "x = 1\n# x\nprint(f\"{x} x\", 'x', obj.x)\n";
    let found = service().identifiers_named(&snap(&py, src), "x", &none()).unwrap();
    assert_eq!(
        found.iter().map(|o| (o.range.start.line, o.qualified)).collect::<Vec<_>>(),
        [(0, false), (2, false), (2, true)]
    );

    let unsupported = service().identifiers_named(&snap(&lang("plaintext"), "x"), "x", &none());
    assert_eq!(unsupported, Err(StructureError::Unsupported));
}

#[test]
fn structural_ranges_statements_and_declarations() {
    let kotlin = lang("kotlin");
    let src = "class A {\n  fun f() {\n    val a = 1\n    val b = a + 1\n    println(b)\n  }\n\n  fun g() {}\n}\n";
    let s = snap(&kotlin, src);
    // Caret in the indentation of `val b`: the statement on that line.
    let r = service().structural_ranges(&s, Pos::new(3, 1), &none()).unwrap();
    let stmt = r.statement.unwrap();
    assert_eq!(stmt.range, span(src, "val b = a + 1"));
    assert_eq!(r.prev_statement.unwrap().range, span(src, "val a = 1"));
    assert_eq!(r.next_statement.unwrap().range, span(src, "println(b)"));
    assert_eq!(r.block.unwrap().kind, "block");
    let decl = r.declaration.unwrap();
    assert_eq!(decl.kind, "function_declaration");
    assert_eq!(r.next_declaration.unwrap().range, span(src, "fun g() {}"));
    assert!(r.prev_declaration.is_none());
    assert!(r.selection.len() > 3);
    assert!(r.selection.windows(2).all(|w| w[0].start >= w[1].start && w[0].end <= w[1].end));

    let py = lang("python");
    let src = "class A:\n    def f(self):\n        a = 1\n        return a\n\n    def g(self):\n        pass\n";
    let r = service().structural_ranges(&snap(&py, src), Pos::new(2, 9), &none()).unwrap();
    assert_eq!(r.statement.unwrap().range, span(src, "a = 1"));
    assert_eq!(r.next_statement.unwrap().range, span(src, "return a"));
    assert_eq!(r.declaration.unwrap().kind, "function_definition");
    assert_eq!(r.next_declaration.unwrap().kind, "function_definition");
}

#[test]
fn support_and_cancellation() {
    let s = service();
    assert_eq!(s.support(&lang("java")), StructureSupport { tree: true, locals: true });
    assert_eq!(s.support(&lang("json")), StructureSupport { tree: true, locals: false });
    assert_eq!(s.support(&lang("plaintext")), StructureSupport::default());
    let cancel = CancellationToken::new();
    cancel.cancel();
    let java = lang("java");
    assert_eq!(s.syntax_errors(&snap(&java, "class A {}"), &cancel), Err(StructureError::Cancelled));
    assert_eq!(s.locals(&snap(&lang("json"), "{}"), Pos::new(0, 0), &none()), Err(StructureError::Unsupported));
}

#[test]
fn open_documents_use_the_incremental_tree() {
    use ide_core::{ChangeSet, DocId, TextChange};
    let syntax = Arc::new(Syntax::new());
    let cache = Arc::new(SyntaxCache::new(syntax));
    let service = StructureService::new(cache.clone());
    let java = lang("java");
    let mut doc = ide_text::Document::new("class A {\n  void f(int a) {\n    int x = a;\n    use(x);\n  }\n}\n");
    let id = DocId::next();
    cache.open(id, &java, doc.version());
    let text = doc.text();
    let at = occ(&text, "x", 2).start;
    let l = service.locals(&Snapshot::doc(id, doc.version(), &java, &text), at, &none()).unwrap();
    assert!(matches!(l, Locals::Local { ref symbol } if symbol.references.len() == 1));
    // Type a new use of `x`; the cache re-parses incrementally.
    let insert_at = doc.pos_to_offset(Pos::new(3, 11));
    let cs =
        ChangeSet { changes: vec![TextChange { from: insert_at, to: insert_at, insert: "\n    use(x + 1);".into() }] };
    let (_, edits) = doc.apply_detailed(doc.version(), &cs).unwrap();
    cache.edit(id, doc.version(), &edits);
    let text = doc.text();
    let l = service.locals(&Snapshot::doc(id, doc.version(), &java, &text), at, &none()).unwrap();
    match l {
        Locals::Local { symbol } => assert_eq!(symbol.references, vec![occ(&text, "x", 2), occ(&text, "x", 3)]),
        other => panic!("{other:?}"),
    }
    let stats = cache.stats();
    assert_eq!((stats.full_parses, stats.incremental_parses), (1, 1), "{stats:?}");
}

#[test]
fn identifiers_in_files_loads_in_parallel_and_skips_misses() {
    use std::path::{Path, PathBuf};
    let files: Vec<(PathBuf, &str, &str)> = vec![
        (PathBuf::from("/p/a.ts"), "typescript", "const total = 1; // total\n"),
        (PathBuf::from("/p/b.py"), "python", "x = 'total'\n"),
        (PathBuf::from("/p/c.txt"), "plaintext", "total\n"),
        (PathBuf::from("/p/d.rs"), "rust", "fn f(total: u32) -> u32 { total }\n"),
    ];
    let mut paths: Vec<PathBuf> = files.iter().map(|f| f.0.clone()).collect();
    paths.push(PathBuf::from("/p/missing.go"));
    let load = |p: &Path| files.iter().find(|f| f.0 == p).map(|f| (lang(f.1), None, f.2.to_owned()));
    let found = service().identifiers_in_files(&paths, "total", load, &none()).unwrap();
    let got: Vec<(String, usize)> = found.iter().map(|f| (f.path.display().to_string(), f.occurrences.len())).collect();
    assert_eq!(got, [("/p/a.ts".to_owned(), 1), ("/p/d.rs".to_owned(), 2)]);
}

// ---------------------------------------------------------------------------
// Vue SFC / HTML: answers from the inline <script> regions' block grammars

#[test]
fn web_containers_support_the_tree_and_locals() {
    let s = service();
    for id in ["vue", "html"] {
        let support = s.support(&lang(id));
        assert!(support.tree, "{id}");
        assert!(support.locals, "{id}");
    }
    let rust = s.support(&lang("rust"));
    assert!(rust.tree && rust.locals, "languages with their own grammar are unchanged");
    let plain = s.support(&lang("plaintext"));
    assert!(!plain.tree && !plain.locals);
}

#[test]
fn node_at_inside_a_script_region_answers_from_the_block_grammar() {
    let src = "<template>\n  <div>{{ n }}</div>\n</template>\n<script lang=\"ts\">\nconst size = 1;\n</script>\n";
    let vue = lang("vue");
    // `size` inside the script: a TypeScript identifier, at document coordinates.
    let at = service().node_at(&snap(&vue, src), occ(src, "size", 1), &none()).unwrap().unwrap();
    assert_eq!(at.node.kind, "identifier");
    assert_eq!(at.node.range, occ(src, "size", 1), "document coordinates");
    assert_eq!(at.node.field.as_deref(), Some("name"));
    // Template markup is not TypeScript: an empty answer, not markup nodes.
    assert!(service().node_at(&snap(&vue, src), occ(src, "div", 1), &none()).unwrap().is_none());
}

#[test]
fn locals_inside_a_script_region_shift_every_range() {
    let src = "<template><div/></template>\n<script lang=\"ts\">\nfunction f() {\n  let count = 0;\n  count += 1;\n}\n</script>\n";
    let vue = lang("vue");
    let byte = occurrences(src, "count")[0];
    let l = service().locals(&snap(&vue, src), pos_of(src, byte), &none()).unwrap();
    let Locals::Local { symbol } = l else {
        panic!("expected a local, got {l:?}");
    };
    assert_eq!(symbol.name, "count");
    assert!(symbol.certain);
    assert_eq!(symbol.definition, occ(src, "count", 1), "definition in document coordinates");
    assert_eq!(symbol.references, vec![occ(src, "count", 2)], "references in document coordinates");
    // Template: no TypeScript identifier here, so nothing local.
    let byte = occurrences(src, "div")[0];
    let l = service().locals(&snap(&vue, src), pos_of(src, byte), &none()).unwrap();
    assert!(matches!(l, Locals::NoIdentifier));
}

#[test]
fn web_script_queries_honour_cancellation_outside_regions() {
    let cancel = CancellationToken::new();
    cancel.cancel();
    for id in ["html", "vue", "svelte", "jsp"] {
        let language = lang(id);
        let src = "<template>中文😀</template><script>let value = 1;</script>";
        let snap = snap(&language, src);
        assert_eq!(service().node_at(&snap, Range::point(Pos::new(0, 2)), &cancel), Err(StructureError::Cancelled));
        assert_eq!(service().locals(&snap, Pos::new(0, 2), &cancel), Err(StructureError::Cancelled));
    }
}

#[test]
fn web_script_queries_compose_utf16_positions_and_isolate_blocks() {
    let src = "<template>中文😀</template><script lang=ts>/* 中文😀 */ function first() { let 名 = '😀'; 名; }</script>\r\n<script setup lang=ts>function second() {\r\nlet 名 = 2;\r\n名;\r\n}</script>";
    for id in ["html", "vue", "svelte", "jsp"] {
        let language = lang(id);
        for (at, def, reference) in [(2, 1, 2), (4, 3, 4)] {
            assert_local(id, src, "名", at, def, &[reference]);
            let r = occ(src, "名", at);
            let node = service().node_at(&snap(&language, src), r, &none()).unwrap().unwrap();
            assert_eq!(node.node.range, r);
            assert_eq!(node.node.kind, "identifier");
        }
    }
}

#[test]
fn web_script_queries_follow_open_document_edits() {
    use ide_core::{ChangeSet, TextChange};

    for id in ["html", "vue", "svelte", "jsp"] {
        let cache = Arc::new(SyntaxCache::new(Arc::new(Syntax::new())));
        let service = StructureService::new(cache.clone());
        let language = lang(id);
        let id = DocId::next();
        let mut doc = ide_text::Document::new("<script>function f() { let x = 1; x; }</script>");
        cache.open(id, &language, 0);
        for version in 0..2 {
            let text = doc.text();
            let snap = Snapshot::doc(id, doc.version(), &language, &text);
            let range = occ(&text, "x", 2);
            let at = service.node_at(&snap, range, &none()).unwrap().unwrap();
            assert_eq!(at.node.range, range);
            let Locals::Local { symbol } = service.locals(&snap, range.start, &none()).unwrap() else {
                panic!("expected local");
            };
            assert_eq!(symbol.definition, occ(&text, "x", 1));
            assert_eq!(symbol.references, [range]);
            if version == 0 {
                let changes =
                    ChangeSet { changes: vec![TextChange { from: 0, to: 0, insert: "<!-- 中文😀 -->\n".into() }] };
                let (_, edits) = doc.apply_detailed(doc.version(), &changes).unwrap();
                cache.edit(id, doc.version(), &edits);
            }
        }
    }
}

#[test]
fn web_script_queries_preserve_parse_size_errors() {
    let src = " ".repeat(ide_language::MAX_PARSE_BYTES + 1);
    for id in ["html", "vue", "svelte", "jsp"] {
        let language = lang(id);
        let snap = snap(&language, &src);
        assert_eq!(service().node_at(&snap, Range::point(Pos::new(0, 0)), &none()), Err(StructureError::TooLarge));
        assert_eq!(service().locals(&snap, Pos::new(0, 0), &none()), Err(StructureError::TooLarge));
    }
}
