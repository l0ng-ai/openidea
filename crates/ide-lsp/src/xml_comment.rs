//! XML comments inside a start tag: IDEA accepts them, LemMinX (Xerces) does not.
//!
//! JGroups' example configs keep optional attributes commented out inside a tag:
//!
//! ```xml
//! <JDBC_PING2
//!         connection_driver="com.mysql.cj.jdbc.Driver"
//!         <!-- insert_sp="CREATE PROCEDURE ..." -->
//! />
//! ```
//!
//! The XML spec's `STag` production has no place for a comment, so the parser
//! stops at `<!--` and reports `ElementUnterminated` for the whole tag. IDEA
//! treats a comment as whitespace there, and no real problem exists: everything
//! outside the comment is a well-formed start tag. Drop only that diagnostic when
//! the reported tag *is* well-formed once its comments are taken out; an actually
//! unterminated tag or an unclosed comment keeps its error.

use lsp_types as lsp;

const MESSAGE_START: &str = "Element type \"";
const MESSAGE_MIDDLE: &str = "\" must be followed by either attribute specifications, \">\" or \"/>\".";

/// Whether `diagnostic` is LemMinX's parse error on a start tag whose only
/// problem (from IDEA's point of view) is a comment between its attributes.
pub(crate) fn false_positive(text: &str, diagnostic: &lsp::Diagnostic) -> bool {
    if !matches!(&diagnostic.code, Some(lsp::NumberOrString::String(c)) if c == "ElementUnterminated") {
        return false;
    }
    let message = diagnostic.message.as_str();
    if !(message.starts_with(MESSAGE_START) && message.contains(MESSAGE_MIDDLE)) {
        return false;
    }
    let (Some(start), Some(end)) = (byte_offset(text, diagnostic.range.start), byte_offset(text, diagnostic.range.end))
    else {
        return false;
    };
    if end < start {
        return false;
    }
    start_tag_with_comment(&text[start..end.min(text.len())])
}

/// Utf-16 line/character → byte offset in `text`, `None` past its end or inside a surrogate pair.
fn byte_offset(text: &str, pos: lsp::Position) -> Option<usize> {
    let mut line_start = 0usize;
    for _ in 0..pos.line {
        line_start += text[line_start..].find('\n')? + 1;
    }
    let line = text[line_start..].split('\n').next().unwrap_or("");
    let line = line.strip_suffix('\r').unwrap_or(line);
    let mut units = 0usize;
    for (byte, c) in line.char_indices() {
        if units == pos.character as usize {
            return Some(line_start + byte);
        }
        units += c.len_utf16();
        if units > pos.character as usize {
            return None;
        }
    }
    (units == pos.character as usize).then_some(line_start + line.len())
}

struct Scanner<'a> {
    bytes: &'a [u8],
    at: usize,
    comments: usize,
}

impl<'a> Scanner<'a> {
    fn new(slice: &'a str) -> Self {
        Self { bytes: slice.as_bytes(), at: 0, comments: 0 }
    }

    fn skip_space_and_comments(&mut self) -> bool {
        loop {
            while self.bytes.get(self.at).is_some_and(u8::is_ascii_whitespace) {
                self.at += 1;
            }
            if self.bytes[self.at..].starts_with(b"<!--") {
                let Some(rel) = find(self.bytes, self.at + 4, b"-->") else { return false };
                self.at = rel + 3;
                self.comments += 1;
                continue;
            }
            return true;
        }
    }

    fn eat(&mut self, b: &[u8]) -> bool {
        if self.bytes[self.at..].starts_with(b) {
            self.at += b.len();
            true
        } else {
            false
        }
    }

    fn name(&mut self) -> bool {
        let is_start = |b: u8| b.is_ascii_alphabetic() || b == b'_' || b == b':';
        let is_rest = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'-' | b'.');
        if !self.bytes.get(self.at).copied().is_some_and(is_start) {
            return false;
        }
        self.at += 1;
        while self.bytes.get(self.at).copied().is_some_and(is_rest) {
            self.at += 1;
        }
        true
    }

    /// `Name (S Attribute)* S? ('>' | '/>')`, with comments skipped as whitespace.
    /// LemMinX's range starts on the name, just after `<`, so the bracket is optional.
    fn start_tag(&mut self) -> bool {
        if !self.skip_space_and_comments() {
            return false;
        }
        self.eat(b"<");
        if !self.name() {
            return false;
        }
        loop {
            if !self.skip_space_and_comments() {
                return false;
            }
            if self.eat(b">") {
                break;
            }
            if self.eat(b"/") {
                return self.eat(b">");
            }
            if !self.name() || !self.skip_space_and_comments() || !self.eat(b"=") || !self.skip_space_and_comments() {
                return false;
            }
            let Some(quote) = self.bytes.get(self.at).copied().filter(|b| matches!(b, b'"' | b'\'')) else {
                return false;
            };
            self.at += 1;
            let Some(rel) = find(self.bytes, self.at, &[quote]) else { return false };
            self.at = rel + 1;
        }
        self.skip_space_and_comments() && self.at == self.bytes.len()
    }
}

fn find(haystack: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if from > haystack.len() {
        return None;
    }
    haystack[from..].windows(needle.len()).position(|w| w == needle).map(|i| from + i)
}

/// The reported range covers a start tag that is well-formed with its comments removed,
/// and at least one comment was inside it.
fn start_tag_with_comment(slice: &str) -> bool {
    if !slice.contains("<!--") {
        return false;
    }
    let mut scan = Scanner::new(slice);
    scan.start_tag() && scan.comments > 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use lsp_types::{Position, Range};

    const MESSAGE: &str =
        "Element type \"JDBC_PING2\" must be followed by either attribute specifications, \">\" or \"/>\".";

    /// A diagnostic spanning `&text[from..to]`, with LSP's UTF-16 columns.
    fn diag(text: &str, from: usize, to: usize) -> lsp::Diagnostic {
        let position = |offset: usize| {
            let before = &text[..offset];
            let line = before.bytes().filter(|b| *b == b'\n').count() as u32;
            let start = before.rfind('\n').map_or(0, |i| i + 1);
            Position::new(line, text[start..offset].chars().map(char::len_utf16).sum::<usize>() as u32)
        };
        lsp::Diagnostic {
            range: Range::new(position(from), position(to)),
            message: MESSAGE.to_owned(),
            code: Some(lsp::NumberOrString::String("ElementUnterminated".into())),
            ..Default::default()
        }
    }

    /// The start tag between `open` and its closing `/>` (or `>`).
    fn over_tag(text: &str, open: &str) -> lsp::Diagnostic {
        let from = text.find(open).unwrap();
        let to = text[from..].find("/>").map_or(text.len(), |i| from + i + 2);
        diag(text, from, to)
    }

    #[test]
    fn commented_tag_is_a_false_positive() {
        // The shape LemMinX publishes for the config in the report: the whole start
        // tag, from `<JDBC_PING2` to `/>`, including a multiline comment.
        let text = "<config>\n  <JDBC_PING2\n      a=\"1\"\n      <!--\n      b=\"2\"\n      -->\n  />\n</config>\n";
        assert!(false_positive(text, &over_tag(text, "<JDBC_PING2")));
        // LemMinX starts the range at the name, after `<`, and ends it after `/>`.
        let text = "    <JDBC_PING2\n        a=\"1\"\n        <!--\n        b=\"2\"\n        -->\n    />\n";
        let from = text.find("JDBC_PING2").unwrap();
        let to = text.find("/>").unwrap() + 2;
        assert!(false_positive(text, &diag(text, from, to)));
        // Single-line comments inside a tag are treated the same way.
        let text = "<root a=\"1\" <!-- b=\"2\" --> />\n";
        assert!(false_positive(text, &over_tag(text, "<root")));
        // UTF-16 columns: a non-ASCII attribute value before the comment.
        let text = "<root a=\"项目\" <!-- b=\"2\" --> />\n";
        assert!(false_positive(text, &over_tag(text, "<root")));
        // Several comments in one tag.
        let text = "<root <!-- a=\"1\" --> b=\"2\" <!-- c=\"3\" --> />\n";
        assert!(false_positive(text, &over_tag(text, "<root")));
    }

    #[test]
    fn lemminx_range_on_a_config_with_a_commented_tag() {
        // LemMinX's `publishDiagnostics` range starts on the name, after `<`, and
        // ends just after `/>` (the shape captured by the probe).
        let text = include_str!("../tests/fixtures/xml_comment_in_tag.xml");
        let from = text.find("JDBC_PING2").unwrap();
        let to = text.find("/>").unwrap() + 2;
        let d = diag(text, from, to);
        assert!(false_positive(text, &d));
        // A schema error over the same tag is a different problem and stays.
        let mut other = d;
        other.code = Some(lsp::NumberOrString::String("cvc-complex-type.2.4.a".into()));
        assert!(!false_positive(text, &other));
    }

    #[test]
    fn genuinely_broken_tags_and_other_errors_still_show() {
        // No comment in the reported tag: an ordinary unterminated element.
        let text = "<root a=1\n";
        assert!(!false_positive(text, &over_tag(text, "<root")));
        // An unclosed comment really does swallow the end of the tag.
        let text = "<root a=\"1\" <!-- b=\"2\" />\n";
        assert!(!false_positive(text, &over_tag(text, "<root")));
        // Other diagnostic codes and messages are never ours to drop.
        let text = "<root a=\"1\" <!-- b=\"2\" --> />\n";
        let mut other = over_tag(text, "<root");
        other.code = Some(lsp::NumberOrString::String("cvc-complex-type.2.4.a".into()));
        assert!(!false_positive(text, &other));
        other.code = Some(lsp::NumberOrString::String("ElementUnterminated".into()));
        other.message = "Element type \"root\" must be declared.".into();
        assert!(!false_positive(text, &other));
        assert!(!false_positive(text, &diag(text, 0, text.find("<!--").unwrap())));
    }

    #[test]
    fn a_comment_between_elements_is_not_a_tag_comment() {
        let text = "<root>\n  <!-- a comment -->\n  <child/>\n</root>\n";
        assert!(!false_positive(text, &diag(text, 0, text.find("<child").unwrap() + 7)));
    }
}
