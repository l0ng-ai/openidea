//! The syntax layer: Mago parses, this module owns the result.
//!
//! - [`ParsedFile`] keeps the source, the arena, the Mago [`Program`], its
//!   parse errors and a [`LineIndex`] together, so one parse serves a whole
//!   request and can be shared across threads behind an `Arc`.
//! - [`LineIndex`] maps Mago's byte offsets to the IDE's 0-based lines and
//!   UTF-16 columns and back.
//! - [`ParseCache`] keeps the latest parse of each open document, keyed by
//!   `(DocId, version)`.
//!
//! Files are always parsed with `recover_incomplete` on: the Mago test-drive
//! (`docs/php-engine/spike.md`) showed that without it an unfinished class at
//! the end of a file disappears with everything inside it, which is the
//! normal state of a document being typed.

mod cache;
mod line_index;
pub mod stack;

pub use cache::ParseCache;
pub use line_index::LineIndex;

use std::sync::Arc;

use ide_core::{Diagnostic, Range, Severity};
use mago_allocator::SharedArena;
use mago_database::file::FileId;
use mago_span::HasSpan;
use mago_syntax::cst::Program;
use mago_syntax::parser::parse_file_content_with_settings;
use mago_syntax::settings::ParserSettings;

/// The `source` of diagnostics produced by the engine.
pub const DIAGNOSTIC_SOURCE: &str = "php";

/// A parse error, located both as bytes and as an IDE range.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntaxError {
    pub message: String,
    /// Byte offsets into the source, end exclusive.
    pub start: u32,
    pub end: u32,
    pub range: Range,
}

impl SyntaxError {
    pub fn to_diagnostic(&self) -> Diagnostic {
        Diagnostic {
            range: self.range,
            severity: Severity::Error,
            message: self.message.clone(),
            source: Some(DIAGNOSTIC_SOURCE.to_owned()),
            code: None,
            unnecessary: false,
            deprecated: false,
            server: None,
        }
    }
}

struct Owner {
    text: Arc<str>,
    /// `SharedArena` rather than `LocalArena`: the arena outlives the parse
    /// inside an `Arc<ParsedFile>` that other threads read, so it must be
    /// `Sync`. The parse itself is single-threaded either way.
    arena: SharedArena,
}

type ProgramRef<'a> = &'a Program<'a>;

self_cell::self_cell!(
    struct Cell {
        owner: Owner,
        #[covariant]
        dependent: ProgramRef,
    }
);

/// One parsed PHP source: text, AST, parse errors and line index.
pub struct ParsedFile {
    cell: Cell,
    file_id: FileId,
    errors: Vec<SyntaxError>,
    line_index: LineIndex,
}

impl ParsedFile {
    /// Parses `text`. `logical_name` only seeds the [`FileId`] stamped on
    /// every span (a path or a document id; it is never read from disk).
    ///
    /// A tree deeper than [`stack::MAX_TREE_DEPTH`] is dropped: the file then
    /// has an empty program and one error at the node past the bound, so no
    /// recursive walk of the engine can overflow its stack on it.
    pub fn parse(logical_name: &str, text: impl Into<Arc<str>>) -> Self {
        let file_id = FileId::new(logical_name.as_bytes());
        let text: Arc<str> = text.into();
        let settings = ParserSettings { recover_incomplete: true, ..ParserSettings::default() };
        let (cell, too_deep) = stack::parser_stack(|| {
            let owner = Owner { text: text.clone(), arena: SharedArena::new() };
            let cell = Cell::new(owner, |owner| {
                parse_file_content_with_settings(&owner.arena, file_id, owner.text.as_bytes(), settings)
            });
            match stack::too_deep(cell.borrow_dependent(), stack::MAX_TREE_DEPTH) {
                None => (cell, None),
                Some(span) => {
                    drop(cell);
                    // The text stays (offsets and lines still map); the
                    // program is that of an empty file.
                    let owner = Owner { text, arena: SharedArena::new() };
                    let empty = Cell::new(owner, |owner| {
                        parse_file_content_with_settings(&owner.arena, file_id, b"", settings)
                    });
                    (empty, Some(span))
                }
            }
        });
        let line_index = LineIndex::new(&cell.borrow_owner().text);
        let syntax_error = |start: u32, end: u32, message: String| {
            // Errors at EOF can reach past the text (an expected token after
            // the last one); clamp so byte slicing stays valid.
            let end = end.min(line_index.len());
            let start = start.min(end);
            SyntaxError { message, start, end, range: line_index.range(start, end) }
        };
        let mut errors: Vec<SyntaxError> = cell
            .borrow_dependent()
            .errors
            .iter()
            .map(|error| {
                let span = error.span();
                syntax_error(span.start.offset, span.end.offset, error.to_string())
            })
            .collect();
        if let Some(span) = too_deep {
            // Only the start: the node can span most of the file.
            let end = line_index.len().min(span.start.offset + 1);
            errors.push(syntax_error(span.start.offset, end, too_deep_message()));
        }
        Self { cell, file_id, errors, line_index }
    }

    pub fn text(&self) -> &str {
        &self.cell.borrow_owner().text
    }

    /// A cheap handle on the source text.
    pub fn shared_text(&self) -> Arc<str> {
        self.cell.borrow_owner().text.clone()
    }

    /// The Mago AST. Its spans are byte offsets into [`text`](Self::text).
    pub fn program(&self) -> &Program<'_> {
        self.cell.borrow_dependent()
    }

    pub fn file_id(&self) -> FileId {
        self.file_id
    }

    /// Parse errors in source order.
    pub fn errors(&self) -> &[SyntaxError] {
        &self.errors
    }

    pub fn has_errors(&self) -> bool {
        !self.errors.is_empty()
    }

    pub fn line_index(&self) -> &LineIndex {
        &self.line_index
    }

    /// The parse errors as IDE diagnostics with source `php`.
    pub fn diagnostics(&self) -> Vec<Diagnostic> {
        self.errors.iter().map(SyntaxError::to_diagnostic).collect()
    }
}

/// The error of a file whose syntax tree is deeper than the engine analyses.
pub fn too_deep_message() -> String {
    format!(
        "Code nested more than {} levels deep: this file is not analysed (split the expression up)",
        stack::MAX_TREE_DEPTH
    )
}

impl std::fmt::Debug for ParsedFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ParsedFile")
            .field("len", &self.text().len())
            .field("statements", &self.program().statements.len())
            .field("errors", &self.errors)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod deep_nesting_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::Pos;
    use mago_syntax::cst::Statement;

    fn assert_send_sync<T: Send + Sync>() {}

    #[test]
    fn parsed_file_is_shareable() {
        assert_send_sync::<ParsedFile>();
        assert_send_sync::<Arc<ParsedFile>>();
    }

    #[test]
    fn clean_file_has_no_errors() {
        let file = ParsedFile::parse(
            "a.php",
            "<?php\nnamespace App;\n\nfinal class A { public function f(): int { return 1; } }\n",
        );
        assert!(!file.has_errors(), "{:?}", file.errors());
        assert!(file.diagnostics().is_empty());
        assert_eq!(file.program().source_text, file.text().as_bytes());
        assert_eq!(file.line_index().line_count(), 5);
    }

    #[test]
    fn spans_map_to_utf16_positions_after_emoji() {
        let text = "<?php\n$greeting = \"héllo 😀\"; function after() {}\n";
        let file = ParsedFile::parse("a.php", text);
        assert!(!file.has_errors(), "{:?}", file.errors());
        let function = file
            .program()
            .statements
            .iter()
            .find_map(|s| match s {
                Statement::Function(f) => Some(f),
                _ => None,
            })
            .expect("function");
        let range = file.line_index().span_range(function.name.span);
        // `$greeting = "héllo 😀"; function ` is 33 chars, 34 UTF-16 units.
        let col = "$greeting = \"héllo 😀\"; function ".encode_utf16().count() as u32;
        assert_eq!(range, Range::new(Pos::new(1, col), Pos::new(1, col + 5)));
        assert_eq!(file.line_index().byte(range.start), function.name.span.start.offset);
    }

    #[test]
    fn crlf_source_positions() {
        let text = "<?php\r\nclass A {}\r\nfunction b() {}\r\n";
        let file = ParsedFile::parse("a.php", text);
        assert!(!file.has_errors(), "{:?}", file.errors());
        let names: Vec<Range> = file
            .program()
            .statements
            .iter()
            .filter_map(|s| match s {
                Statement::Class(c) => Some(c.name.span),
                Statement::Function(f) => Some(f.name.span),
                _ => None,
            })
            .map(|span| file.line_index().span_range(span))
            .collect();
        assert_eq!(
            names,
            vec![Range::new(Pos::new(1, 6), Pos::new(1, 7)), Range::new(Pos::new(2, 9), Pos::new(2, 10))]
        );
    }

    #[test]
    fn html_mixed_with_php() {
        let text = "<!doctype html>\n<title><?= $title ?></title>\n<ul>\n<?php foreach ($items as $item): ?>\n  <li>é <?php echo $item; ?></li>\n<?php endforeach; ?>\n</ul>\n";
        let file = ParsedFile::parse("view.php", text);
        assert!(!file.has_errors(), "{:?}", file.errors());
        assert!(file.program().statements.iter().any(|s| matches!(s, Statement::Inline(_))));
        assert!(file.program().has_script());
    }

    #[test]
    fn broken_input_reports_located_errors() {
        let text = "<?php\nclass A {\n    public function a() {}\n    public function b( {\n}\n$x = ;\n";
        let file = ParsedFile::parse("broken.php", text);
        assert!(file.has_errors());
        for error in file.errors() {
            assert!(error.start <= error.end && error.end as usize <= text.len(), "{error:?}");
            assert_eq!(error.range, file.line_index().range(error.start, error.end));
            assert!(!error.message.is_empty());
        }
        let diagnostics = file.diagnostics();
        assert_eq!(diagnostics.len(), file.errors().len());
        assert!(diagnostics.iter().all(|d| d.severity == Severity::Error && d.source.as_deref() == Some("php")));
        // The first error is on the line of the unfinished parameter list.
        assert!(file.errors()[0].range.start.line >= 3, "{:?}", file.errors());
    }

    #[test]
    fn unfinished_class_survives_at_eof() {
        let file = ParsedFile::parse(
            "typing.php",
            "<?php\nclass Unfinished {\n    public function done() {}\n    public function typ",
        );
        assert!(file.has_errors());
        assert!(
            file.program().statements.iter().any(|s| matches!(s, Statement::Class(c) if c.name.value == b"Unfinished"))
        );
    }

    #[test]
    fn error_at_eof_maps_to_last_position() {
        let text = "<?php\n$s = 'é😀";
        let file = ParsedFile::parse("eof.php", text);
        assert!(file.has_errors());
        let last = file.line_index().pos(text.len() as u32);
        assert!(file.errors().iter().all(|e| e.range.end <= last), "{:?}", file.errors());
    }

    #[test]
    fn never_panics_on_any_prefix() {
        let text =
            "<?php\r\nnamespace A;\n/** é */\nclass B { function c(): string { return \"😀 {$x}\"; } }\n?>\n<p>x</p>\n";
        for end in (0..=text.len()).filter(|&end| text.is_char_boundary(end)) {
            let file = ParsedFile::parse("p.php", &text[..end]);
            for error in file.errors() {
                assert!(error.end as usize <= end);
            }
        }
    }
}
