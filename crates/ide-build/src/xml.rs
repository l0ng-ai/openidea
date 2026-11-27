//! A small, forgiving XML element reader for POM files: elements, text and
//! CDATA; attributes, comments, processing instructions and DOCTYPEs are
//! skipped. Namespace prefixes are dropped (`<x:project>` → `project`).
//! Elements keep their byte offsets in the source, for edits ([`crate::pom_edit`]).

use encoding_rs::Encoding;
use std::path::Path;

/// Reads an XML file, honoring its `encoding="…"` declaration: a GBK POM
/// (issue #2439) is not valid UTF-8, and `read_to_string` would drop the
/// whole project as "No maven project" while CLI Maven reads it fine.
pub fn read_text(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|bytes| decode_bytes(&bytes))
}

/// Decodes XML bytes: BOM first, then the `encoding` declaration (ASCII in
/// every single-byte encoding, so the head scans before decoding), then
/// UTF-8, then a chardetng guess.
pub fn decode_bytes(bytes: &[u8]) -> String {
    if let Some((enc, len)) = Encoding::for_bom(bytes) {
        let (text, _) = enc.decode_without_bom_handling(&bytes[len..]);
        return text.into_owned();
    }
    if let Some(enc) = declared_encoding(bytes) {
        let (text, _) = enc.decode_without_bom_handling(bytes);
        return text.into_owned();
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_owned();
    }
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    let (text, _) = detector.guess(None, true).decode_without_bom_handling(bytes);
    text.into_owned()
}

fn declared_encoding(bytes: &[u8]) -> Option<&'static Encoding> {
    let head = std::str::from_utf8(bytes.get(..bytes.len().min(1024))?).ok()?;
    let mut rest = head.split("?>").next().unwrap_or(head);
    while let Some(i) = rest.find("encoding") {
        rest = &rest[i + "encoding".len()..];
        let Some(value) = rest.trim_start().strip_prefix('=') else { continue };
        let value = value.trim_start();
        let (&quote, after) = value.as_bytes().split_first()?;
        if quote != b'"' && quote != b'\'' {
            continue;
        }
        let after = std::str::from_utf8(after).ok()?;
        let end = after.find(quote as char)?;
        if let Some(enc) = Encoding::for_label(after[..end].trim().as_bytes()) {
            return Some(enc);
        }
    }
    None
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Element {
    pub name: String,
    pub text: String,
    pub children: Vec<Element>,
    /// Byte offset of the start tag's `<`.
    pub start: usize,
    /// Byte offset of the end tag's `<` (`end` for an empty or unclosed element).
    pub inner_end: usize,
    /// Byte offset just past the end tag (past the start tag for `<empty/>`).
    pub end: usize,
}

impl Element {
    pub fn child(&self, name: &str) -> Option<&Element> {
        self.children.iter().find(|c| c.name == name)
    }

    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Element> + 'a {
        self.children.iter().filter(move |c| c.name == name)
    }

    /// Trimmed text of the child `name`, if present and non-empty.
    pub fn text_of(&self, name: &str) -> Option<String> {
        self.child(name).map(|c| c.text.trim().to_owned()).filter(|t| !t.is_empty())
    }

    /// Element at a `/`-separated path of child names.
    pub fn at(&self, path: &str) -> Option<&Element> {
        path.split('/').try_fold(self, |e, name| e.child(name))
    }

    /// Children of the element at `path` (empty when missing).
    pub fn list<'a>(&'a self, path: &str, item: &'a str) -> Vec<&'a Element> {
        self.at(path).map(|e| e.children_named(item).collect()).unwrap_or_default()
    }
}

fn decode_entities(raw: &str, out: &mut String) {
    let mut rest = raw;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let Some(end) = tail.find(';').filter(|&e| e <= 12) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..end];
        let ch = match entity {
            "lt" => Some('<'),
            "gt" => Some('>'),
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            e if e.starts_with("#x") || e.starts_with("#X") => {
                u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32)
            }
            e if e.starts_with('#') => e[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => out.push(c),
            None => out.push_str(&tail[..=end]),
        }
        rest = &tail[end + 1..];
    }
    out.push_str(rest);
}

fn local(name: &str) -> String {
    name.rsplit(':').next().unwrap_or(name).to_owned()
}

/// Parses `text` and returns its root element, or `None` when there is none.
/// Unbalanced end tags close the innermost matching element; unclosed elements
/// are closed at the end of input.
pub fn parse(text: &str) -> Option<Element> {
    let mut stack: Vec<Element> = vec![Element::default()];
    let mut rest = text;
    let at = |rest: &str| text.len() - rest.len();
    while !rest.is_empty() {
        let Some(lt) = rest.find('<') else {
            decode_entities(rest, &mut stack.last_mut()?.text);
            break;
        };
        if lt > 0 {
            decode_entities(&rest[..lt], &mut stack.last_mut()?.text);
        }
        let tag = &rest[lt..];
        if let Some(body) = tag.strip_prefix("<!--") {
            rest = body.find("-->").map_or("", |e| &body[e + 3..]);
        } else if let Some(body) = tag.strip_prefix("<![CDATA[") {
            let end = body.find("]]>").unwrap_or(body.len());
            stack.last_mut()?.text.push_str(&body[..end]);
            rest = body.get(end + 3..).unwrap_or("");
        } else if tag.starts_with("<?") {
            rest = tag.find("?>").map_or("", |e| &tag[e + 2..]);
        } else if tag.starts_with("<!") {
            rest = tag.find('>').map_or("", |e| &tag[e + 1..]);
        } else if let Some(body) = tag.strip_prefix("</") {
            let end = body.find('>').unwrap_or(body.len());
            let name = local(body[..end].trim());
            let close_start = at(tag);
            rest = body.get(end + 1..).unwrap_or("");
            let close_end = at(rest);
            if let Some(i) = stack.iter().rposition(|e| e.name == name).filter(|&i| i > 0) {
                while stack.len() > i {
                    let mut done = stack.pop()?;
                    // Elements closed implicitly by an outer end tag end where it starts.
                    let matched = stack.len() == i;
                    done.inner_end = close_start;
                    done.end = if matched { close_end } else { close_start };
                    stack.last_mut()?.children.push(done);
                }
            }
        } else {
            // Start or empty tag; skip quoted attribute values when looking for `>`.
            let bytes = tag.as_bytes();
            let mut i = 1;
            let mut quote: Option<u8> = None;
            while i < bytes.len() {
                match (quote, bytes[i]) {
                    (Some(q), b) if b == q => quote = None,
                    (Some(_), _) => {}
                    (None, b'"' | b'\'') => quote = Some(bytes[i]),
                    (None, b'>') => break,
                    _ => {}
                }
                i += 1;
            }
            let inner = &tag[1..i.min(tag.len())];
            let empty = inner.ends_with('/');
            let inner = inner.trim_end_matches('/');
            let name_end = inner.find(|c: char| c.is_whitespace()).unwrap_or(inner.len());
            let start = at(tag);
            rest = tag.get(i + 1..).unwrap_or("");
            let after = at(rest);
            let el =
                Element { name: local(&inner[..name_end]), start, inner_end: after, end: after, ..Element::default() };
            if empty {
                stack.last_mut()?.children.push(el);
            } else {
                stack.push(el);
            }
        }
    }
    while stack.len() > 1 {
        let mut done = stack.pop()?;
        done.inner_end = text.len();
        done.end = text.len();
        stack.last_mut()?.children.push(done);
    }
    stack.pop()?.children.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elements_text_and_markup_noise() {
        let doc = r#"<?xml version="1.0"?>
<!DOCTYPE x>
<!-- header -->
<p:project xmlns:p="urn" a="1 > 2">
  <name>A &amp; B &#x41;&#66;</name>
  <empty/>
  <desc><![CDATA[<raw>]]></desc>
  <!-- <name>ignored</name> -->
  <list><item>1</item><item attr='/>'>2</item></list>
</p:project>"#;
        let root = parse(doc).unwrap();
        assert_eq!(root.name, "project");
        assert_eq!(root.text_of("name").as_deref(), Some("A & B AB"));
        assert!(root.child("empty").is_some());
        assert_eq!(root.text_of("empty"), None);
        assert_eq!(root.text_of("desc").as_deref(), Some("<raw>"));
        let items: Vec<String> = root.list("list", "item").iter().map(|e| e.text.clone()).collect();
        assert_eq!(items, ["1", "2"]);
        assert_eq!(root.children_named("name").count(), 1);
    }

    #[test]
    fn element_offsets() {
        let doc = "<a>\n  <b>x</b><c/>\n</a>";
        let root = parse(doc).unwrap();
        assert_eq!((root.start, root.inner_end, root.end), (0, doc.len() - 4, doc.len()));
        let b = root.child("b").unwrap();
        assert_eq!(&doc[b.start..b.end], "<b>x</b>");
        assert_eq!(&doc[b.start..b.inner_end], "<b>x");
        let c = root.child("c").unwrap();
        assert_eq!(&doc[c.start..c.end], "<c/>");
        let broken = parse("<a><b>x</a>").unwrap();
        let b = broken.child("b").unwrap();
        assert_eq!((b.inner_end, b.end), (7, 7));
        assert_eq!(broken.end, 11);
    }

    #[test]
    fn tolerates_broken_documents() {
        let root = parse("<a><b>x</c><d>y").unwrap();
        assert_eq!(root.at("b").unwrap().text, "x");
        assert_eq!(root.at("b/d").unwrap().text, "y");
        assert!(parse("").is_none());
        assert!(parse("just text").is_none());
    }

    #[test]
    fn decodes_the_declared_encoding() {
        // Issue #2439: a GBK POM is not valid UTF-8; decoding must honor the declaration.
        let (bytes, _, _) =
            encoding_rs::GBK.encode("<?xml version=\"1.0\" encoding=\"GBK\"?>\n<project><name>中文</name></project>");
        let text = decode_bytes(&bytes);
        assert_eq!(parse(&text).unwrap().text_of("name").as_deref(), Some("中文"));
        // An unknown label falls back to UTF-8 rather than mis-decoding.
        let text = decode_bytes(b"<?xml version=\"1.0\" encoding=\"X-UNKNOWN\"?>\n<project><name>ok</name></project>");
        assert_eq!(parse(&text).unwrap().text_of("name").as_deref(), Some("ok"));
        // No declaration: plain UTF-8 passes through untouched.
        let text = decode_bytes("<project><name>plain</name></project>".as_bytes());
        assert_eq!(parse(&text).unwrap().text_of("name").as_deref(), Some("plain"));
    }
}
