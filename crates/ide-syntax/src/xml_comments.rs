//! Comments between a start tag's attributes:
//!
//! ```xml
//! <JDBC_PING2 connection_driver="com.mysql.cj.jdbc.Driver"
//!     <!-- insert_sp="CREATE PROCEDURE ..." -->
//! />
//! ```
//!
//! The spec has no place for them and the tree-sitter grammar rejects them, but IDEA reads them as
//! whitespace and configuration files keep optional attributes that way (JGroups' examples).

/// `text` with every complete comment inside a start tag replaced by spaces of the same UTF-16
/// width (line breaks kept), so positions in it are positions in `text`; `None` when there is
/// no such comment. An unclosed comment is left as it is: that one is a real error.
pub(crate) fn blank_in_start_tags(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let rest = &bytes[at..];
        if rest.starts_with(b"<!--") {
            at = skip_past(bytes, at + 4, b"-->");
        } else if rest.starts_with(b"<![CDATA[") {
            at = skip_past(bytes, at + 9, b"]]>");
        } else if rest.starts_with(b"<?") {
            at = skip_past(bytes, at + 2, b"?>");
        } else if rest.starts_with(b"<!") {
            at = skip_past(bytes, at + 2, b">");
        } else if rest.first() == Some(&b'<') && rest.get(1).is_some_and(|&b| b != b'/') {
            at = start_tag(bytes, at + 1, &mut spans);
        } else {
            at += 1;
        }
    }
    if spans.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    for (from, to) in spans {
        out.push_str(&text[copied..from]);
        for c in text[from..to].chars() {
            if c == '\n' || c == '\r' {
                out.push(c);
            } else {
                out.extend(std::iter::repeat_n(' ', c.len_utf16()));
            }
        }
        copied = to;
    }
    out.push_str(&text[copied..]);
    Some(out)
}

/// Scans a start tag from just after its `<` to just after its `>` (or where it is cut off),
/// collecting the comments in it.
fn start_tag(bytes: &[u8], mut at: usize, spans: &mut Vec<(usize, usize)>) -> usize {
    while at < bytes.len() {
        match bytes[at] {
            b'>' => return at + 1,
            // Another tag starts: this one was never closed.
            b'<' if !bytes[at..].starts_with(b"<!--") => return at,
            b'<' => {
                let end = skip_past(bytes, at + 4, b"-->");
                if !bytes[..end].ends_with(b"-->") || end < at + 7 {
                    return end;
                }
                spans.push((at, end));
                at = end;
            }
            quote @ (b'"' | b'\'') => at = skip_past(bytes, at + 1, &[quote]),
            _ => at += 1,
        }
    }
    at
}

/// The index just past the first `needle` at or after `from`, or the end of `bytes`.
fn skip_past(bytes: &[u8], from: usize, needle: &[u8]) -> usize {
    if from >= bytes.len() {
        return bytes.len();
    }
    memchr::memmem::find(&bytes[from..], needle).map_or(bytes.len(), |i| from + i + needle.len())
}

#[cfg(test)]
mod tests {
    use super::blank_in_start_tags;

    #[test]
    fn blanks_only_complete_comments_inside_start_tags() {
        let text = "<a x=\"1\"\n  <!-- y=\"é😀\" -->\n/>";
        let blanked = blank_in_start_tags(text).unwrap();
        assert_eq!(blanked, "<a x=\"1\"\n  ".to_owned() + &" ".repeat(16) + "\n/>");
        assert_eq!(blanked.lines().count(), text.lines().count());

        // Between elements, inside a value, in CDATA or in an unclosed comment: nothing to do.
        for text in [
            "<a>\n  <!-- c -->\n  <b/>\n</a>",
            "<a x=\"<!-- not a comment -->\"/>",
            "<a><![CDATA[<b <!-- c --> />]]></a>",
            "<a x=\"1\" <!-- y=\"2\" />",
            "<!-- <a <!-- --> -->",
        ] {
            assert_eq!(blank_in_start_tags(text), None, "{text}");
        }
    }
}
