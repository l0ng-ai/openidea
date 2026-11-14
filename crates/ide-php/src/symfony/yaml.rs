//! A reader for the part of YAML Symfony's configuration files use: block
//! mappings and sequences by indentation, flow mappings and sequences
//! (`{ resource: '../src/' }`, `[a, b]`), plain, single- and double-quoted
//! scalars, comments, and block scalars (`|`, `>`), whose text is skipped.
//! Anchors, aliases, tags and multi-document streams aren't interpreted:
//! a tag stays in the scalar's text, and documents after `---` are read as
//! if they continued the first. It never fails: what it can't read is
//! skipped.
//!
//! Every block mapping key keeps its range (0-based line, UTF-16 columns)
//! for goto.

use ide_core::{Pos, Range};

/// A YAML value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Node {
    /// `~`, `null`, or nothing.
    Null,
    /// A scalar's text, unquoted.
    Scalar(String),
    Map(Vec<Entry>),
    Seq(Vec<Node>),
}

/// A mapping entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub key: String,
    /// Where the key is written; empty for keys of flow mappings.
    pub range: Range,
    pub value: Node,
}

impl Node {
    /// The value of `key` in a mapping.
    pub fn get(&self, key: &str) -> Option<&Node> {
        match self {
            Self::Map(entries) => entries.iter().find(|entry| entry.key == key).map(|entry| &entry.value),
            _ => None,
        }
    }

    /// The text of a scalar.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Scalar(text) => Some(text),
            _ => None,
        }
    }

    /// The entries of a mapping (none for anything else).
    pub fn entries(&self) -> &[Entry] {
        match self {
            Self::Map(entries) => entries,
            _ => &[],
        }
    }

    /// The items of a sequence (none for anything else).
    pub fn items(&self) -> &[Node] {
        match self {
            Self::Seq(items) => items,
            _ => &[],
        }
    }
}

/// One non-blank line, its comment removed.
#[derive(Clone, Debug)]
struct Line<'t> {
    /// 0-based.
    number: u32,
    /// The whole line, for UTF-16 columns.
    raw: &'t str,
    /// Byte column of `content` in `raw`.
    indent: usize,
    content: &'t str,
}

/// Parses `text` (a whole file). A file that isn't a mapping or sequence
/// at its top level is [`Node::Null`].
pub fn parse(text: &str) -> Node {
    let lines: Vec<Line<'_>> = text
        .lines()
        .enumerate()
        .filter_map(|(number, raw)| {
            let raw = raw.strip_suffix('\r').unwrap_or(raw);
            let content = strip_comment(raw).trim_end();
            let trimmed = content.trim_start();
            if trimmed.is_empty() || trimmed == "---" || trimmed == "..." || trimmed.starts_with('%') {
                return None;
            }
            let indent = content.len() - trimmed.len();
            Some(Line { number: number as u32, raw, indent, content: trimmed })
        })
        .collect();
    let mut parser = Parser { lines, at: 0 };
    let Some(first) = parser.lines.first() else { return Node::Null };
    let indent = first.indent;
    parser.block(indent)
}

struct Parser<'t> {
    lines: Vec<Line<'t>>,
    at: usize,
}

impl<'t> Parser<'t> {
    fn peek(&self) -> Option<&Line<'t>> {
        self.lines.get(self.at)
    }

    /// The block (mapping or sequence) whose lines start at `indent`.
    fn block(&mut self, indent: usize) -> Node {
        match self.peek() {
            Some(line) if line.indent == indent && is_item(line.content) => self.sequence(indent),
            Some(line) if line.indent == indent => self.mapping(indent),
            _ => Node::Null,
        }
    }

    fn mapping(&mut self, indent: usize) -> Node {
        let mut entries = Vec::new();
        while let Some(line) = self.peek().cloned() {
            if line.indent < indent || (line.indent == indent && is_item(line.content)) {
                break;
            }
            self.at += 1;
            if line.indent > indent {
                // Indented further than its siblings without a key above:
                // not something this reader understands.
                continue;
            }
            let Some((key, rest)) = split_key(line.content) else { continue };
            let key_start = line.indent + (key.as_ptr() as usize - line.content.as_ptr() as usize);
            let range = Range::new(
                Pos::new(line.number, utf16_col(line.raw, key_start)),
                Pos::new(line.number, utf16_col(line.raw, key_start + key.len())),
            );
            let value = self.value(rest, indent, true);
            entries.push(Entry { key: unquote(key), range, value });
        }
        Node::Map(entries)
    }

    fn sequence(&mut self, indent: usize) -> Node {
        let mut items = Vec::new();
        while let Some(line) = self.peek().cloned() {
            if line.indent != indent || !is_item(line.content) {
                if line.indent > indent {
                    self.at += 1;
                    continue;
                }
                break;
            }
            let rest = line.content[1..].trim_start();
            if rest.is_empty() {
                self.at += 1;
                items.push(self.nested(indent));
                continue;
            }
            let offset = line.content.len() - rest.len();
            if !rest.starts_with(['{', '[', '"', '\'']) && split_key(rest).is_some() {
                // `- key: value`: a mapping whose keys line up with `key`.
                let at = line.indent + offset;
                self.lines[self.at] = Line { indent: at, content: rest, ..line };
                items.push(self.mapping(at));
                continue;
            }
            self.at += 1;
            items.push(self.value(rest, indent, false));
        }
        Node::Seq(items)
    }

    /// What follows a key (`in_mapping`) or a `- `: inline, or a block on
    /// the next lines.
    fn value(&mut self, rest: &str, indent: usize, in_mapping: bool) -> Node {
        if rest.is_empty() {
            // `key:` with a sequence at the same indentation is allowed.
            if in_mapping
                && let Some(next) = self.peek()
                && next.indent == indent
                && is_item(next.content)
            {
                return self.sequence(indent);
            }
            return self.nested(indent);
        }
        if rest.starts_with('|') || rest.starts_with('>') {
            while self.peek().is_some_and(|line| line.indent > indent) {
                self.at += 1;
            }
            return Node::Scalar(String::new());
        }
        if rest.starts_with(['{', '[']) && !balanced(rest) {
            // A flow collection over several lines.
            let mut text = rest.to_owned();
            while !balanced(&text)
                && let Some(next) = self.peek()
            {
                text.push(' ');
                text.push_str(next.content);
                self.at += 1;
            }
            return inline(&text);
        }
        inline(rest)
    }

    /// A block indented further than `indent`, or null.
    fn nested(&mut self, indent: usize) -> Node {
        match self.peek() {
            Some(next) if next.indent > indent => {
                let indent = next.indent;
                self.block(indent)
            }
            _ => Node::Null,
        }
    }
}

/// `- item` or `-`.
fn is_item(content: &str) -> bool {
    content == "-" || content.starts_with("- ")
}

/// The UTF-16 column of byte `at` of `line`.
fn utf16_col(line: &str, at: usize) -> u32 {
    line.get(..at.min(line.len())).map_or(0, |prefix| prefix.encode_utf16().count() as u32)
}

/// `line` without its comment: a `#` at the start or after a space, outside
/// quotes.
fn strip_comment(line: &str) -> &str {
    let mut quote: Option<char> = None;
    let mut previous = ' ';
    for (i, c) in line.char_indices() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '#' && previous.is_whitespace() => return &line[..i],
            None if (c == '\'' || c == '"') && (previous.is_whitespace() || "[{,:-".contains(previous)) => {
                quote = Some(c);
            }
            None => {}
        }
        previous = c;
    }
    line
}

/// `key: rest` → (`key`, `rest`): the first `:` followed by a space or the
/// end of the line, outside quotes and brackets.
fn split_key(content: &str) -> Option<(&str, &str)> {
    let at = key_colon(content)?;
    let key = content[..at].trim_end();
    (!key.is_empty()).then(|| (key, content[at + 1..].trim()))
}

fn key_colon(content: &str) -> Option<usize> {
    let bytes = content.as_bytes();
    let mut quote: Option<u8> = None;
    let mut depth = 0i32;
    for (i, &b) in bytes.iter().enumerate() {
        match quote {
            Some(q) if b == q => quote = None,
            Some(_) => {}
            None => match b {
                b'\'' | b'"' if i == 0 => quote = Some(b),
                b'{' | b'[' => depth += 1,
                b'}' | b']' => depth -= 1,
                b':' if depth == 0 && bytes.get(i + 1).is_none_or(|next| *next == b' ' || *next == b'\t') => {
                    return Some(i);
                }
                _ => {}
            },
        }
    }
    None
}

/// Whether the brackets of a flow collection close.
fn balanced(text: &str) -> bool {
    let mut quote: Option<char> = None;
    let mut depth = 0i32;
    for c in text.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None => match c {
                '\'' | '"' => quote = Some(c),
                '{' | '[' => depth += 1,
                '}' | ']' => depth -= 1,
                _ => {}
            },
        }
    }
    depth <= 0
}

/// A value written on one line: a flow collection or a scalar.
fn inline(text: &str) -> Node {
    let text = text.trim();
    if let Some(body) = text.strip_prefix('{') {
        let body = body.strip_suffix('}').unwrap_or(body);
        let entries = split_flow(body)
            .into_iter()
            .filter_map(|item| {
                let (key, value) = match key_colon(item) {
                    Some(at) => (item[..at].trim(), inline(&item[at + 1..])),
                    None => (item.trim(), Node::Null),
                };
                (!key.is_empty()).then(|| Entry { key: unquote(key), range: Range::default(), value })
            })
            .collect();
        return Node::Map(entries);
    }
    if let Some(body) = text.strip_prefix('[') {
        let body = body.strip_suffix(']').unwrap_or(body);
        return Node::Seq(split_flow(body).into_iter().map(inline).collect());
    }
    if text.is_empty() || text == "~" || text.eq_ignore_ascii_case("null") {
        return Node::Null;
    }
    Node::Scalar(unquote(text))
}

/// The comma-separated items of a flow collection's body.
fn split_flow(body: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut quote: Option<char> = None;
    let mut depth = 0i32;
    let mut start = 0;
    for (i, c) in body.char_indices() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None => match c {
                '\'' | '"' => quote = Some(c),
                '{' | '[' => depth += 1,
                '}' | ']' => depth -= 1,
                ',' if depth == 0 => {
                    out.push(body[start..i].trim());
                    start = i + 1;
                }
                _ => {}
            },
        }
    }
    out.push(body[start..].trim());
    out.retain(|item| !item.is_empty());
    out
}

/// A scalar's text without its quotes: `''` in single quotes is `'`, and
/// the usual escapes in double quotes (`\\` is `\`).
fn unquote(text: &str) -> String {
    let text = text.trim();
    if text.len() >= 2 && text.starts_with('\'') && text.ends_with('\'') {
        return text[1..text.len() - 1].replace("''", "'");
    }
    if text.len() >= 2 && text.starts_with('"') && text.ends_with('"') {
        let mut out = String::new();
        let mut chars = text[1..text.len() - 1].chars();
        while let Some(c) = chars.next() {
            if c != '\\' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            }
        }
        return out;
    }
    text.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scalar(text: &str) -> Node {
        Node::Scalar(text.to_owned())
    }

    #[test]
    fn mappings_sequences_and_flow_collections() {
        let text = "\
# comment
imports:
    - { resource: 'services_dev.yaml' }
    - resource: other/
      ignore_errors: true

services: # inline comment
    _defaults:
        autowire: true
    App\\:
        resource: '../src/'
        exclude:
            - '../src/Kernel.php'
    mailer.default: { class: App\\Mailer, arguments: ['@logger', \"a, b\"] }
    'quoted.id': '@mailer.default'
    App\\Service\\Clock: ~
    text: |
        anything: here
        - goes
    after: \"x # not a comment\"
    list:
    - a
    - b
";
        let root = parse(text);
        let imports = root.get("imports").unwrap().items();
        assert_eq!(imports.len(), 2);
        assert_eq!(imports[0].get("resource"), Some(&scalar("services_dev.yaml")));
        assert_eq!(imports[1].get("resource"), Some(&scalar("other/")));
        assert_eq!(imports[1].get("ignore_errors"), Some(&scalar("true")));
        let services = root.get("services").unwrap();
        let keys: Vec<&str> = services.entries().iter().map(|entry| entry.key.as_str()).collect();
        assert_eq!(
            keys,
            ["_defaults", "App\\", "mailer.default", "quoted.id", "App\\Service\\Clock", "text", "after", "list"]
        );
        assert_eq!(services.get("App\\").unwrap().get("exclude").unwrap().items(), [scalar("../src/Kernel.php")]);
        let mailer = services.get("mailer.default").unwrap();
        assert_eq!(mailer.get("class"), Some(&scalar("App\\Mailer")));
        assert_eq!(mailer.get("arguments").unwrap().items(), [scalar("@logger"), scalar("a, b")]);
        assert_eq!(services.get("quoted.id"), Some(&scalar("@mailer.default")));
        assert_eq!(services.get("App\\Service\\Clock"), Some(&Node::Null));
        assert_eq!(services.get("after"), Some(&scalar("x # not a comment")));
        assert_eq!(services.get("list").unwrap().items(), [scalar("a"), scalar("b")]);
        // The key's range: line 14 (0-based), after four spaces.
        let entry = services.entries().iter().find(|entry| entry.key == "mailer.default").unwrap();
        assert_eq!(entry.range, Range::new(Pos::new(13, 4), Pos::new(13, 18)));
        let quoted = services.entries().iter().find(|entry| entry.key == "quoted.id").unwrap();
        assert_eq!(quoted.range, Range::new(Pos::new(14, 4), Pos::new(14, 15)));
    }

    #[test]
    fn multi_line_flow_and_odd_input_never_fail() {
        let root = parse("a: { b: 1,\n     c: 2 }\nd: [x,\n  y]\n");
        assert_eq!(root.get("a").unwrap().get("c"), Some(&scalar("2")));
        assert_eq!(root.get("d").unwrap().items(), [scalar("x"), scalar("y")]);
        for text in ["", "---\n", "just text", "  - a\n b: c\n   d", "a: [\n", "'x: y", ":\n:"] {
            let _ = parse(text);
        }
        // UTF-16 columns.
        let root = parse("é: 1\n  ünï: 2\n");
        assert_eq!(root.entries()[0].range, Range::new(Pos::new(0, 0), Pos::new(0, 1)));
    }
}
