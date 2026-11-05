//! A declaration outline of one PHP file, built with the Mago parser.
//!
//! This is the probe the Mago test-drive measures: it parses a file, resolves
//! names, collects named declarations (with whether a docblock precedes them)
//! and parses those docblocks. `examples/parse_corpus.rs` runs it over the
//! corpora and compares outlines of whole and truncated files to score error
//! recovery. Phase 1.1 replaces it with the real `syntax` module.

use mago_allocator::LocalArena;
use mago_database::file::FileId;
use mago_names::resolver::NameResolver;
use mago_phpdoc_syntax::PHPDocParser;
use mago_span::HasSpan;
use mago_syntax::comments::docblock::get_docblock_for_node;
use mago_syntax::cst::{Class, Enum, Function, Interface, Method, Program, Trait};
use mago_syntax::parser::parse_file_content_with_settings;
use mago_syntax::settings::ParserSettings;
use mago_syntax::walker::Walker;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum DeclKind {
    Class,
    Interface,
    Trait,
    Enum,
    Function,
    Method,
}

/// A named declaration. Offsets are bytes into the parsed source.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Decl {
    pub kind: DeclKind,
    pub name: String,
    pub name_start: u32,
    pub name_end: u32,
    pub has_docblock: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Outline {
    pub declarations: Vec<Decl>,
    /// Rendered parse errors, in source order.
    pub errors: Vec<String>,
    pub top_level_statements: usize,
    /// Identifiers `mago-names` resolved to a fully qualified name.
    pub resolved_names: usize,
    pub docblocks: usize,
    /// The first `mago-phpdoc-syntax` error of each docblock that has one,
    /// with the docblock's start offset.
    pub docblock_errors: Vec<(u32, String)>,
}

/// How the parser treats a file that ends in the middle of a construct.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recovery {
    /// Mago's default: unfinished bodies at EOF are dropped.
    Default,
    /// `recover_incomplete`: keep unfinished bodies and lists at EOF, as an
    /// editor needs while the user types.
    Incomplete,
}

/// Parses `source` and builds its outline. The arena is dropped on return.
pub fn outline(source: &[u8], recovery: Recovery) -> Outline {
    let arena = LocalArena::new();
    let settings = ParserSettings { recover_incomplete: recovery == Recovery::Incomplete, ..ParserSettings::default() };
    let program = parse_file_content_with_settings(&arena, FileId::new(b"probe"), source, settings);
    let resolved = NameResolver::new(&arena).resolve(program);

    let mut collector = Collector { program, declarations: Vec::new() };
    DeclWalker.walk_program(program, &mut collector);

    let mut docblocks = 0;
    let mut docblock_errors = Vec::new();
    for decl in &collector.declarations {
        let Some(doc) = decl.1 else { continue };
        docblocks += 1;
        let parsed = PHPDocParser::parse_with_span(&arena, doc.value, doc.span);
        if let Some(error) = parsed.errors.first() {
            docblock_errors.push((doc.span.start.offset, error.to_string()));
        }
    }

    Outline {
        declarations: collector.declarations.into_iter().map(|(decl, _)| decl).collect(),
        errors: program.errors.iter().map(ToString::to_string).collect(),
        top_level_statements: program.statements.len(),
        resolved_names: resolved.len(),
        docblocks,
        docblock_errors,
    }
}

type DocTrivia<'arena> = mago_syntax::cst::Trivia<'arena>;

struct Collector<'arena> {
    program: &'arena Program<'arena>,
    declarations: Vec<(Decl, Option<&'arena DocTrivia<'arena>>)>,
}

impl<'arena> Collector<'arena> {
    fn push(&mut self, kind: DeclKind, name: &mago_syntax::cst::LocalIdentifier<'arena>, node: impl HasSpan) {
        let doc = get_docblock_for_node(self.program, node);
        self.declarations.push((
            Decl {
                kind,
                name: String::from_utf8_lossy(name.value).into_owned(),
                name_start: name.span.start.offset,
                name_end: name.span.end.offset,
                has_docblock: doc.is_some(),
            },
            doc,
        ));
    }
}

struct DeclWalker;

impl<'ast, 'arena> Walker<'ast, 'arena, Collector<'arena>> for DeclWalker {
    fn walk_in_class(&self, node: &'ast Class<'arena>, cx: &mut Collector<'arena>) {
        cx.push(DeclKind::Class, &node.name, node);
    }
    fn walk_in_interface(&self, node: &'ast Interface<'arena>, cx: &mut Collector<'arena>) {
        cx.push(DeclKind::Interface, &node.name, node);
    }
    fn walk_in_trait(&self, node: &'ast Trait<'arena>, cx: &mut Collector<'arena>) {
        cx.push(DeclKind::Trait, &node.name, node);
    }
    fn walk_in_enum(&self, node: &'ast Enum<'arena>, cx: &mut Collector<'arena>) {
        cx.push(DeclKind::Enum, &node.name, node);
    }
    fn walk_in_function(&self, node: &'ast Function<'arena>, cx: &mut Collector<'arena>) {
        cx.push(DeclKind::Function, &node.name, node);
    }
    fn walk_in_method(&self, node: &'ast Method<'arena>, cx: &mut Collector<'arena>) {
        cx.push(DeclKind::Method, &node.name, node);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(outline: &Outline) -> Vec<(DeclKind, &str)> {
        outline.declarations.iter().map(|d| (d.kind, d.name.as_str())).collect()
    }

    const SAMPLE: &str = r#"<?php
namespace App\Model;

use App\Contracts\Lendable;

/**
 * A book. 📚
 * @template T of object
 */
final class Book implements Lendable
{
    /** @return non-empty-string */
    public function title(): string { return "Dune"; }
    public function lend(): void {}
}

interface Shelf { public function books(): array; }
trait Stamps { public function stamp(): void {} }
enum Genre: string { case Fiction = 'f'; }

function slugify(string $s): string { return strtolower($s); }
"#;

    #[test]
    fn collects_every_declaration_kind() {
        let outline = outline(SAMPLE.as_bytes(), Recovery::Default);
        assert!(outline.errors.is_empty(), "{:?}", outline.errors);
        assert_eq!(
            names(&outline),
            vec![
                (DeclKind::Class, "Book"),
                (DeclKind::Method, "title"),
                (DeclKind::Method, "lend"),
                (DeclKind::Interface, "Shelf"),
                (DeclKind::Method, "books"),
                (DeclKind::Trait, "Stamps"),
                (DeclKind::Method, "stamp"),
                (DeclKind::Enum, "Genre"),
                (DeclKind::Function, "slugify"),
            ]
        );
    }

    #[test]
    fn name_offsets_are_bytes_into_the_source() {
        let outline = outline(SAMPLE.as_bytes(), Recovery::Default);
        for decl in &outline.declarations {
            let text = &SAMPLE.as_bytes()[decl.name_start as usize..decl.name_end as usize];
            assert_eq!(text, decl.name.as_bytes());
        }
    }

    #[test]
    fn finds_and_parses_docblocks() {
        let outline = outline(SAMPLE.as_bytes(), Recovery::Default);
        let documented: Vec<_> =
            outline.declarations.iter().filter(|d| d.has_docblock).map(|d| d.name.as_str()).collect();
        assert_eq!(documented, vec!["Book", "title"]);
        assert_eq!(outline.docblocks, 2);
        assert!(outline.docblock_errors.is_empty(), "{:?}", outline.docblock_errors);
    }

    #[test]
    fn resolves_names() {
        let outline = outline(SAMPLE.as_bytes(), Recovery::Default);
        // At least Lendable, the declared class-likes and strtolower.
        assert!(outline.resolved_names >= 4, "{}", outline.resolved_names);
    }

    #[test]
    fn reports_errors_and_keeps_declarations_before_them() {
        let source = "<?php\nclass A { function a() {} }\nfunction ( {\nclass B {}\n";
        let outline = outline(source.as_bytes(), Recovery::Default);
        assert!(!outline.errors.is_empty());
        let names = names(&outline);
        assert!(names.contains(&(DeclKind::Class, "A")), "{names:?}");
        assert!(names.contains(&(DeclKind::Method, "a")), "{names:?}");
    }

    #[test]
    fn incomplete_recovery_keeps_an_unfinished_class() {
        let source = "<?php\nclass Unfinished {\n    public function done() {}\n    public function typing(";
        let incomplete = outline(source.as_bytes(), Recovery::Incomplete);
        assert!(!incomplete.errors.is_empty());
        let names = names(&incomplete);
        assert!(names.contains(&(DeclKind::Class, "Unfinished")), "{names:?}");
        assert!(names.contains(&(DeclKind::Method, "done")), "{names:?}");
    }

    #[test]
    fn mixed_html_and_crlf_parse_cleanly() {
        let source = "<html>\r\n<?php function head() { ?>\r\n<title>é</title>\r\n<?php } ?>\r\n</html>\r\n";
        let outline = outline(source.as_bytes(), Recovery::Default);
        assert!(outline.errors.is_empty(), "{:?}", outline.errors);
        assert_eq!(names(&outline), vec![(DeclKind::Function, "head")]);
    }

    #[test]
    fn never_panics_on_any_prefix() {
        for end in 0..=SAMPLE.len() {
            if SAMPLE.is_char_boundary(end) {
                let _ = outline(&SAMPLE.as_bytes()[..end], Recovery::Incomplete);
                let _ = outline(&SAMPLE.as_bytes()[..end], Recovery::Default);
            }
        }
    }
}
