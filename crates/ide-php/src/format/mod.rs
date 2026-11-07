//! Document and range formatting through `mago-formatter` (MIT OR Apache-2.0).
//!
//! The style is Mago's PSR-12 preset; only the indentation (spaces or tabs
//! and their width) and the line length come from the editor
//! ([`FormatOptions`]). Line endings are always `\n`, because documents are
//! normalized to `\n` in the editor.
//!
//! - Whole documents are printed again and compared with the source; the
//!   answer is one edit covering the changed part (or none).
//! - A range formats the smallest statement or class member enclosing it
//!   (imports expand to their group), as `Formatter::format_range` chooses.
//!
//! The formatter refuses source with syntax errors: such files get no edits
//! rather than an error, so format-on-save of a half-typed file stays quiet.

use std::borrow::Cow;

use ide_core::{DocId, Range, TextEdit};
use mago_allocator::LocalArena;
use mago_database::file::File;
use mago_formatter::Formatter;
use mago_formatter::presets::FormatterPreset;
use mago_formatter::settings::{EndOfLine, FormatSettings};
use mago_php_version::PHPVersion;

use crate::engine::PhpEngine;
use crate::stubs::PhpVersion;
use crate::syntax::LineIndex;

/// The editor's side of the style.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FormatOptions {
    /// Spaces per indentation level, and the width of a tab.
    pub indent: u32,
    pub use_tabs: bool,
    /// The line length the printer tries to stay within (Code Style › Hard wrap at).
    pub line_width: u32,
}

impl Default for FormatOptions {
    /// PSR-12: four spaces, lines up to 120 columns.
    fn default() -> Self {
        Self { indent: 4, use_tabs: false, line_width: 120 }
    }
}

impl FormatOptions {
    /// Mago's PSR-12 preset with the editor's indentation and line length.
    /// The preset's spaces inside grouping parentheses (`( $a + $b ) * 2`)
    /// are off: PSR-12 doesn't ask for them, and PHP-CS-Fixer's PSR-12
    /// rule set and PhpStorm's PSR-12 scheme don't write them.
    pub fn settings(&self) -> FormatSettings {
        FormatSettings {
            print_width: self.line_width.max(1) as usize,
            tab_width: self.indent.max(1) as usize,
            use_tabs: self.use_tabs,
            end_of_line: EndOfLine::Lf,
            space_within_grouping_parenthesis: false,
            ..FormatterPreset::Psr12.settings()
        }
    }
}

/// Mago's version for a language level: it decides syntax the printer may
/// use (for example `new Foo()->m()` without parentheses from PHP 8.4).
fn mago_version(version: PhpVersion) -> PHPVersion {
    PHPVersion::new(u32::from(version.major), u32::from(version.minor), 0)
}

/// One replacement in byte offsets of the source, end exclusive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ByteEdit {
    pub start: u32,
    pub end: u32,
    pub text: String,
}

/// The edit that formats `text`, or the statement or member around the byte
/// range `range`; `None` when nothing changes or the source doesn't parse.
pub fn format_text(
    text: &str,
    range: Option<(u32, u32)>,
    version: PhpVersion,
    options: &FormatOptions,
) -> Option<ByteEdit> {
    let arena = LocalArena::new();
    let formatter = Formatter::new(&arena, mago_version(version), options.settings());
    let file = File::ephemeral(Cow::Borrowed(b"format.php"), Cow::Owned(text.as_bytes().to_vec()));
    let (start, end, new) = match range {
        None => {
            let formatted = formatter.format_file(&file).ok()?;
            (0, text.len(), std::str::from_utf8(formatted).ok()?)
        }
        Some((from, to)) => {
            let formatted = formatter.format_range(&file, from.min(to)..to.max(from)).ok()??;
            let new = std::str::from_utf8(formatted.new_text).ok()?;
            (formatted.range.start as usize, formatted.range.end as usize, new)
        }
    };
    minimal_edit(text, start, end, new)
}

/// Shrinks the replacement of `text[start..end]` by `new` to the part that
/// differs, on character boundaries.
fn minimal_edit(text: &str, start: usize, end: usize, new: &str) -> Option<ByteEdit> {
    let old = text.get(start..end)?;
    if old == new {
        return None;
    }
    let mut prefix = old.bytes().zip(new.bytes()).take_while(|(a, b)| a == b).count();
    while !old.is_char_boundary(prefix) || !new.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let (old_rest, new_rest) = (&old[prefix..], &new[prefix..]);
    let mut suffix = old_rest.bytes().rev().zip(new_rest.bytes().rev()).take_while(|(a, b)| a == b).count();
    while !old_rest.is_char_boundary(old_rest.len() - suffix) || !new_rest.is_char_boundary(new_rest.len() - suffix) {
        suffix -= 1;
    }
    Some(ByteEdit {
        start: (start + prefix) as u32,
        end: (end - suffix) as u32,
        text: new_rest[..new_rest.len() - suffix].to_owned(),
    })
}

/// [`format_text`] with IDE positions: the edits for `text` (described by
/// `lines`), or for the statements and members around `range`.
pub fn format_edits(
    text: &str,
    lines: &LineIndex,
    range: Option<Range>,
    version: PhpVersion,
    options: &FormatOptions,
) -> Vec<TextEdit> {
    let bytes = range.map(|range| lines.byte_range(range));
    format_text(text, bytes, version, options)
        .map(|edit| TextEdit { range: lines.range(edit.start, edit.end), new_text: edit.text })
        .into_iter()
        .collect()
}

impl PhpEngine {
    /// Reformat Code for an open document, or for the statements and
    /// members around `range`, at the project's language level. `None` when
    /// the engine doesn't hold the document.
    pub fn format(&self, doc: DocId, range: Option<Range>, options: &FormatOptions) -> Option<Vec<TextEdit>> {
        let parsed = self.parsed_document(doc)?;
        Some(format_edits(parsed.text(), parsed.line_index(), range, self.language_level(), options))
    }
}

#[cfg(test)]
mod tests;
