//! String Tools for OpenIDEA: text transformations on every selection of the
//! focused editor, applied as one undoable change. An empty selection
//! (a cursor) works on the word under it; line commands on whole lines.

use openidea_plugin::text::{offset, position};
use openidea_plugin::{Error, Invocation, Plugin, Range, TextEdit, TextEditor, register_plugin};

#[derive(Default)]
pub struct StringTools;

impl Plugin for StringTools {
    fn run_command(&mut self, id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        let transform = transform(id).ok_or_else(|| Error::NotFound(format!("command {id}")))?;
        let editor = ctx.editor().ok_or("String Tools works on the focused editor")?;
        apply(&editor, transform, lines_command(id))?;
        Ok(None)
    }
}

register_plugin!(StringTools);

type Transform = fn(&str) -> String;

fn lines_command(id: &str) -> bool {
    matches!(id, "sort-lines" | "sort-lines-desc" | "reverse-lines" | "unique-lines" | "trim-lines")
}

fn transform(id: &str) -> Option<Transform> {
    Some(match id {
        "camel-case" => |s| join_words(s, Style::Camel),
        "pascal-case" => |s| join_words(s, Style::Pascal),
        "snake-case" => |s| join_words(s, Style::Snake),
        "screaming-snake-case" => |s| join_words(s, Style::ScreamingSnake),
        "kebab-case" => |s| join_words(s, Style::Kebab),
        "dot-case" => |s| join_words(s, Style::Dot),
        "title-case" => title_case,
        "upper-case" => |s| s.to_uppercase(),
        "lower-case" => |s| s.to_lowercase(),
        "toggle-case" => toggle_case,
        "base64-encode" => |s| base64_encode(s.as_bytes()),
        "base64-decode" => {
            |s| base64_decode(s).map_or_else(|| s.to_owned(), |b| String::from_utf8_lossy(&b).into_owned())
        }
        "url-encode" => url_encode,
        "url-decode" => url_decode,
        "html-escape" => html_escape,
        "html-unescape" => html_unescape,
        "json-escape" => json_escape,
        "sort-lines" => |s| map_lines(s, |l| l.sort()),
        "sort-lines-desc" => |s| map_lines(s, |l| l.sort_by(|a, b| b.cmp(a))),
        "reverse-lines" => |s| map_lines(s, |l| l.reverse()),
        "unique-lines" => |s| {
            map_lines(s, |l| {
                let mut seen = std::collections::HashSet::new();
                l.retain(|x| seen.insert(x.to_owned()));
            })
        },
        "trim-lines" => |s| s.split('\n').map(str::trim).collect::<Vec<_>>().join("\n"),
        "reverse" => |s| s.chars().rev().collect(),
        "swap-quotes" => |s| {
            s.chars()
                .map(|c| match c {
                    '"' => '\'',
                    '\'' => '"',
                    c => c,
                })
                .collect()
        },
        "increment" => |s| step_numbers(s, 1),
        "decrement" => |s| step_numbers(s, -1),
        _ => return None,
    })
}

/// Replaces each selection with `f(text)`: an empty one expands to the word
/// under the cursor, or (`lines`) every selection to its whole lines.
/// Retried once if the user typed meanwhile.
fn apply(editor: &TextEditor, f: Transform, lines: bool) -> Result<u64, Error> {
    let selections = editor.selections()?;
    for _ in 0..2 {
        let doc = editor.document()?;
        let mut edits = Vec::with_capacity(selections.len());
        for r in &selections {
            let range = if lines { line_range(&doc.text, *r) } else { word_range(&doc.text, *r) };
            let Some(old) = doc.text_in(range) else { continue };
            let new = f(old);
            if new != old {
                edits.push(TextEdit { range, text: new });
            }
        }
        // Overlapping selections (two cursors in one word) edit once.
        edits.sort_by_key(|e| e.range);
        edits.dedup_by(|b, a| b.range.start < a.range.end);
        match editor.apply_edits(doc.version, &edits) {
            Err(Error::Stale) => continue,
            other => return other,
        }
    }
    Err(Error::Stale)
}

fn word_range(text: &str, r: Range) -> Range {
    if !r.is_empty() {
        return r;
    }
    let Some(at) = offset(text, r.start) else { return r };
    let word = |c: char| c.is_alphanumeric() || c == '_' || c == '-' || c == '.';
    let start = text[..at].char_indices().rev().take_while(|(_, c)| word(*c)).last().map_or(at, |(i, _)| i);
    let end = text[at..].char_indices().find(|(_, c)| !word(*c)).map_or(text.len(), |(i, _)| at + i);
    Range::new(position(text, start), position(text, end))
}

fn line_range(text: &str, r: Range) -> Range {
    let start = openidea_plugin::Position::new(r.start.line, 0);
    let end_line = if r.end.character == 0 && r.end.line > r.start.line { r.end.line - 1 } else { r.end.line };
    let line_end = text.split('\n').nth(end_line as usize).map_or(0, |l| l.encode_utf16().count() as u32);
    Range::new(start, openidea_plugin::Position::new(end_line, line_end))
}

#[derive(Clone, Copy)]
enum Style {
    Camel,
    Pascal,
    Snake,
    ScreamingSnake,
    Kebab,
    Dot,
}

/// Splits identifiers on separators and case changes: `fooBar_baz-qux` →
/// [foo, Bar, baz, qux]; `HTTPServer` → [HTTP, Server].
fn words(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if !c.is_alphanumeric() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            continue;
        }
        let prev = i.checked_sub(1).map(|j| chars[j]);
        let next = chars.get(i + 1).copied();
        let boundary = c.is_uppercase()
            && prev.is_some_and(|p| {
                p.is_lowercase() || p.is_ascii_digit() || (p.is_uppercase() && next.is_some_and(char::is_lowercase))
            });
        if boundary && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
        cur.push(c);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn capitalize(w: &str) -> String {
    let mut c = w.chars();
    c.next().map(|f| f.to_uppercase().chain(c.flat_map(char::to_lowercase)).collect()).unwrap_or_default()
}

fn join_words(s: &str, style: Style) -> String {
    // Keep surrounding whitespace (a whole-line selection).
    let lead = &s[..s.len() - s.trim_start().len()];
    let trail = &s[s.trim_end().len()..];
    let w = words(s);
    let body = match style {
        Style::Camel => {
            w.iter().enumerate().map(|(i, x)| if i == 0 { x.to_lowercase() } else { capitalize(x) }).collect()
        }
        Style::Pascal => w.iter().map(|x| capitalize(x)).collect(),
        Style::Snake => w.iter().map(|x| x.to_lowercase()).collect::<Vec<_>>().join("_"),
        Style::ScreamingSnake => w.iter().map(|x| x.to_uppercase()).collect::<Vec<_>>().join("_"),
        Style::Kebab => w.iter().map(|x| x.to_lowercase()).collect::<Vec<_>>().join("-"),
        Style::Dot => w.iter().map(|x| x.to_lowercase()).collect::<Vec<_>>().join("."),
    };
    if body.is_empty() { s.to_owned() } else { format!("{lead}{body}{trail}") }
}

fn title_case(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut start = true;
    for c in s.chars() {
        if start && c.is_alphabetic() {
            out.extend(c.to_uppercase());
            start = false;
        } else {
            out.extend(c.to_lowercase());
            start = c.is_whitespace();
        }
    }
    out
}

fn toggle_case(s: &str) -> String {
    s.chars()
        .flat_map(|c| -> Box<dyn Iterator<Item = char>> {
            if c.is_uppercase() { Box::new(c.to_lowercase()) } else { Box::new(c.to_uppercase()) }
        })
        .collect()
}

fn map_lines(s: &str, f: impl FnOnce(&mut Vec<&str>)) -> String {
    let mut lines: Vec<&str> = s.split('\n').collect();
    f(&mut lines);
    lines.join("\n")
}

/// Adds `by` to every integer in `s` (keeping zero padding).
fn step_numbers(s: &str, by: i64) -> String {
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() {
            let start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            let neg = start > 0 && chars[start - 1] == '-' && (start < 2 || !chars[start - 2].is_alphanumeric());
            let digits: String = chars[start..i].iter().collect();
            match digits.parse::<i64>() {
                Ok(n) => {
                    let n = if neg { -n } else { n };
                    let next = n.saturating_add(by);
                    if neg {
                        out.pop(); // the minus sign
                    }
                    let width = digits.len();
                    let text = if next < 0 { format!("-{:0width$}", -next) } else { format!("{next:0width$}") };
                    out.push_str(&text);
                }
                Err(_) => out.push_str(&digits),
            }
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let clean: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let clean = clean.strip_suffix(b"==").or_else(|| clean.strip_suffix(b"=")).unwrap_or(&clean);
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    for chunk in clean.chunks(4) {
        if chunk.len() == 1 {
            return None;
        }
        let mut n = 0u32;
        for (i, b) in chunk.iter().enumerate() {
            let v = B64.iter().position(|x| x == b).or(match b {
                b'-' => Some(62),
                b'_' => Some(63),
                _ => None,
            })?;
            n |= (v as u32) << (18 - 6 * i);
        }
        for i in 0..chunk.len() - 1 {
            out.push((n >> (16 - 8 * i)) as u8);
        }
    }
    Some(out)
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |j: usize| bytes.get(j).and_then(|b| (*b as char).to_digit(16));
        match bytes[i] {
            b'%' if hex(i + 1).is_some() && hex(i + 2).is_some() => {
                out.push((hex(i + 1).unwrap() * 16 + hex(i + 2).unwrap()) as u8);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

fn html_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest[..rest.len().min(12)].find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some('\u{a0}'),
            e if e.starts_with("#x") || e.starts_with("#X") => {
                u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32)
            }
            e if e.starts_with('#') => e[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::mock::MockHost;

    #[test]
    fn cases() {
        let t = |id: &str, s: &str| transform(id).unwrap()(s);
        assert_eq!(t("camel-case", "hello_world-again"), "helloWorldAgain");
        assert_eq!(t("pascal-case", "HTTPServer error"), "HttpServerError");
        assert_eq!(t("snake-case", "parseHTTPResponse2Fast"), "parse_http_response2_fast");
        assert_eq!(t("screaming-snake-case", "maxValue"), "MAX_VALUE");
        assert_eq!(t("kebab-case", "  FooBar  "), "  foo-bar  ");
        assert_eq!(t("dot-case", "a_b"), "a.b");
        assert_eq!(t("title-case", "the QUICK fox"), "The Quick Fox");
        assert_eq!(t("toggle-case", "aBc"), "AbC");
    }

    #[test]
    fn encodings_round_trip() {
        for s in ["", "f", "fo", "foo", "héllo wörld ✓"] {
            assert_eq!(base64_decode(&base64_encode(s.as_bytes())).unwrap(), s.as_bytes());
            assert_eq!(url_decode(&url_encode(s)), s);
            assert_eq!(html_unescape(&html_escape(s)), s);
        }
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(url_encode("a b&c"), "a%20b%26c");
        assert_eq!(html_unescape("&lt;a&gt; &#x41;&#66; &bogus; &"), "<a> AB &bogus; &");
        assert_eq!(json_escape("a\"b\n"), "a\\\"b\\n");
    }

    #[test]
    fn lines_and_numbers() {
        let t = |id: &str, s: &str| transform(id).unwrap()(s);
        assert_eq!(t("sort-lines", "b\na\nc"), "a\nb\nc");
        assert_eq!(t("unique-lines", "a\nb\na"), "a\nb");
        assert_eq!(t("increment", "v1.09 and -1"), "v2.10 and 0");
        assert_eq!(t("decrement", "x0"), "x-1");
    }

    #[test]
    fn every_selection_and_cursor_in_one_undoable_change() {
        let host = MockHost::install();
        host.open_editor("/p/a.rs", "rust", "let fooBar = baz_qux;\n", &[(0, 6, 0, 6), (0, 13, 0, 20)]);
        StringTools.run_command("snake-case", &host.invocation(), None).unwrap();
        assert_eq!(host.editor_text(), "let foo_bar = baz_qux;\n");
        assert_eq!(host.editor_version(), 2, "one change for both");
        // The editor sends the (moved) selections with the next command.
        host.open_editor("/p/a.rs", "rust", &host.editor_text(), &[(0, 4, 0, 11), (0, 14, 0, 21)]);
        StringTools.run_command("upper-case", &host.invocation(), None).unwrap();
        assert_eq!(host.editor_text(), "let FOO_BAR = BAZ_QUX;\n");
    }

    #[test]
    fn line_commands_take_whole_lines() {
        let host = MockHost::install();
        host.open_editor("/p/a.txt", "text", "c\nb\na\nz", &[(0, 0, 3, 0)]);
        StringTools.run_command("sort-lines", &host.invocation(), None).unwrap();
        assert_eq!(host.editor_text(), "a\nb\nc\nz");
    }

    #[test]
    fn degrades_without_write_access() {
        let host = MockHost::install().with_capabilities(&["editor.read"]);
        host.open_editor("/p/a.txt", "text", "abc", &[(0, 0, 0, 3)]);
        let err = StringTools.run_command("upper-case", &host.invocation(), None).unwrap_err();
        assert_eq!(err, Error::Denied("editor.write".into()));
        assert_eq!(host.editor_text(), "abc");
    }
}
