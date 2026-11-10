//! Deeply nested PHP must never overflow a stack (phase 8.29). Each test runs
//! on a thread with a 2 MB stack, the default for a spawned thread, and the
//! engine's own threads keep their default size too. Before the fix, in a
//! debug build, Mago needed about 32 MB to parse a few thousand nested
//! closures, a 300-member union in a docblock (an AWS SDK client in Bagisto's
//! `vendor/`) overflowed indexing, and fifteen nested array literals
//! overflowed type inference.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use ide_core::{CancellationToken, DocId, IdeEvent, Pos, Range, SharedSink};

use super::stack::{MAX_TREE_DEPTH, too_deep};
use super::{ParsedFile, too_deep_message};
use crate::engine::{CACHE_SUBDIR, EngineConfig, PhpEngine};
use crate::names::NameKind;
use crate::project::LayoutConfig;
use crate::stubs::StubFilter;
use crate::summary::FileSummary;
use crate::types::parse_doc_type;

/// Levels of the deep sources: far past Mago's limit of 512 and past
/// [`MAX_TREE_DEPTH`].
const LEVELS: usize = 3_000;

/// Runs `f` on a thread with a 2 MB stack and returns its result.
fn on_small_stack<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> R {
    std::thread::Builder::new().stack_size(2 << 20).spawn(f).unwrap().join().unwrap()
}

fn nested(open: &str, close: &str, levels: usize) -> String {
    format!("{}1{}", open.repeat(levels), close.repeat(levels))
}

fn statement(expr: String) -> String {
    format!("<?php\nnamespace Deep;\n\n$x = {expr};\n")
}

fn union(members: usize) -> String {
    (0..members).map(|i| format!("'X12_{i}'")).collect::<Vec<_>>().join("|")
}

/// PHP nested `n` levels deep, by construct.
/// Builds a source nested the given number of levels deep.
type Make = fn(usize) -> String;

const CONSTRUCTS: &[(&str, Make)] = &[
    ("arrays", |n| statement(nested("[", "]", n))),
    ("keyed_arrays", |n| statement(nested("['k' => ", "]", n))),
    ("parentheses", |n| statement(nested("(", ")", n))),
    ("calls", |n| statement(nested("f(", ")", n))),
    ("closures", |n| statement(nested("function () { return ", "; }", n))),
    ("arrow_functions", |n| statement(format!("{}1", "fn () => ".repeat(n)))),
    ("anonymous_classes", |n| statement(nested("new class { function f() { return ", "; } }", n))),
    ("matches", |n| statement(nested("match (1) { default => ", " }", n))),
    ("ternaries", |n| statement(nested("$a ? 1 : (", ")", n))),
    ("negations", |n| statement(format!("{}1", "!".repeat(n)))),
    ("assignments", |n| statement(format!("{}1", "$a = ".repeat(n)))),
    ("ifs", |n| format!("<?php\n{}{}\n", "if ($a) { ".repeat(n), "}".repeat(n))),
    ("concatenation", |n| statement(vec!["'a'"; n].join(" . "))),
    ("and_chain", |n| statement(vec!["$a"; n].join(" && "))),
    ("method_chain", |n| statement(format!("$a{}", "->b()".repeat(n)))),
    ("property_chain", |n| statement(format!("$a{}", "->b".repeat(n)))),
    ("index_chain", |n| statement(format!("$a{}", "[0]".repeat(n)))),
    ("coalesce", |n| statement(vec!["$a"; n].join(" ?? "))),
    ("docblock", |n| {
        format!(
            "<?php\nnamespace Deep;\n\n/**\n * @method \\Deep\\Result run(array{{set?: {}, ...}} $args = [])\n * @param array{{a: {}}} $x\n */\nclass Client {{\n    /** @param {} $x */\n    public function f($x) {{}}\n}}\n",
            union(n),
            nested("array{a: ", "}", n),
            union(n)
        )
    }),
];

fn is_dropped(parsed: &ParsedFile) -> bool {
    parsed.errors().iter().any(|error| error.message == too_deep_message())
}

/// The deepest source of `make` that the engine still analyses.
fn deepest_accepted(make: Make) -> String {
    // Each level adds at least one node, so `MAX_TREE_DEPTH` levels are
    // always too deep.
    let (mut accepted, mut rejected) = (1, MAX_TREE_DEPTH + 1);
    while accepted + 1 < rejected {
        let middle = (accepted + rejected) / 2;
        if is_dropped(&ParsedFile::parse("probe.php", make(middle))) {
            rejected = middle;
        } else {
            accepted = middle;
        }
    }
    make(accepted)
}

/// `(file name, source)`: each construct far too deep, and at the deepest
/// the engine accepts.
fn sources() -> Vec<(String, String)> {
    CONSTRUCTS
        .iter()
        .flat_map(|(name, make)| {
            [(format!("{name}_deep.php"), make(LEVELS)), (format!("{name}_accepted.php"), deepest_accepted(*make))]
        })
        .collect()
}

#[test]
fn parse_and_summary_survive_thousands_of_nested_levels() {
    on_small_stack(|| {
        for (name, make) in CONSTRUCTS {
            let parsed = ParsedFile::parse(name, make(LEVELS));
            let summary = FileSummary::extract(&parsed);
            if *name == "docblock" {
                // The docblock is too deep for Mago's PHPDoc parser, not the
                // class: it stays.
                assert!(!is_dropped(&parsed), "{:?}", parsed.errors());
                assert!(summary.class_likes.iter().any(|c| c.fqn.ends_with("Client")));
            } else if name.ends_with("_chain") || *name == "concatenation" {
                // Mago parses these in a loop, with no limit of its own.
                assert!(is_dropped(&parsed), "{name}: a tree {LEVELS} levels deep is dropped");
            } else {
                // Mago's limit or the bound.
                assert!(parsed.has_errors(), "{name}: {LEVELS} levels are reported");
            }
        }
        let _ = parse_doc_type(&union(LEVELS), &[]);
        let _ = parse_doc_type(&nested("array{a: ", "}", LEVELS), &[]);
        let _ = parse_doc_type(&nested("list<", ">", LEVELS), &[]);
    });
}

#[test]
fn a_tree_past_the_bound_is_dropped_with_a_diagnostic() {
    on_small_stack(|| {
        let deep = format!("<?php\n\nclass Kept {{}}\n$x = {};\n", vec!["'a'"; MAX_TREE_DEPTH].join(" . "));
        let parsed = ParsedFile::parse("deep.php", deep.as_str());
        assert!(too_deep(parsed.program(), 0).is_none(), "the program of a too deep file is empty");
        let errors: Vec<_> = parsed.errors().iter().filter(|e| e.message == too_deep_message()).collect();
        assert_eq!(errors.len(), 1, "{:?}", parsed.errors());
        assert_eq!(errors[0].range.start.line, 3, "the error is on the deep statement");
        assert_eq!(parsed.text(), deep, "the text is kept");
        assert!(parsed.diagnostics().iter().any(|d| d.message == too_deep_message()));

        // A long concatenation within the bound, like those of compiled
        // Blade templates, is analysed as usual.
        let long = format!("<?php\n\nclass Kept {{}}\n$x = {};\n", vec!["'a'"; MAX_TREE_DEPTH / 4].join(" . "));
        let parsed = ParsedFile::parse("long.php", long.as_str());
        assert!(!parsed.has_errors(), "{:?}", parsed.errors());
        assert_eq!(parsed.program().statements.len(), 3);
        assert!(FileSummary::extract(&parsed).class_likes.iter().any(|c| c.fqn.ends_with("Kept")));
    });
}

#[test]
fn the_engine_indexes_and_answers_on_deeply_nested_files() {
    on_small_stack(|| {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("composer.json"), r#"{"autoload":{"psr-4":{"Deep\\":"src/"}}}"#).unwrap();
        std::fs::write(root.join("src/Plain.php"), "<?php\nnamespace Deep;\n\nclass Plain {}\n").unwrap();
        let sources = sources();
        for (name, source) in &sources {
            std::fs::write(root.join("src").join(name), source).unwrap();
        }
        let config = EngineConfig {
            cache_dir: base.join("cache").join(CACHE_SUBDIR),
            layout: LayoutConfig { root: root.clone(), ..LayoutConfig::default() },
            stubs: StubFilter::default(),
        };
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        let engine = PhpEngine::open(config, sink).unwrap();
        assert!(engine.wait_idle(Duration::from_secs(300)));
        let index = engine.index().unwrap();
        assert!(!index.declarations(NameKind::ClassLike, "Deep\\Plain").unwrap().is_empty());
        assert!(!index.declarations(NameKind::ClassLike, "Deep\\Client").unwrap().is_empty());

        let cancel = CancellationToken::new();
        for (name, source) in &sources {
            answer_everything(&engine, &root.join("src").join(name), source, &cancel);
        }
        engine.shutdown();
    });
}

/// Opens `path` and asks the engine for what an editor asks for.
fn answer_everything(engine: &PhpEngine, path: &Path, source: &str, cancel: &CancellationToken) {
    let doc = DocId::next();
    engine.document_opened(doc, path, 1, source);
    let parsed = engine.parsed_document(doc).unwrap();
    let lines = parsed.line_index();
    let end = lines.pos(source.len() as u32);
    // Inside the deepest part of the expression, and on the variable.
    let middle = lines.pos(source.len() as u32 / 2);
    let variable = lines.pos(source.find("$x").map_or(0, |at| at as u32 + 1));
    let _ = engine.inspect(doc, cancel);
    let _ = engine.semantic_tokens(doc);
    let _ = engine.document_symbols(doc);
    let _ = engine.inlay_hints(doc, Range::new(Pos::new(0, 0), end));
    for pos in [variable, middle, end] {
        let _ = engine.type_at(doc, pos);
        let _ = engine.hover(doc, pos);
        let _ = engine.definition(doc, pos);
        let _ = engine.completion(doc, pos, None, cancel);
    }
    let _ = engine.inspect_file(path, source, cancel);
    engine.document_closed(doc);
}
