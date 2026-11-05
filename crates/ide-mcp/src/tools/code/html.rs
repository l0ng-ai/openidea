// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.toolsets/src/util/HtmlToMarkdownConverter.kt), Apache-2.0.
//! Documentation as Markdown. IntelliJ renders Quick Documentation as HTML and converts
//! it; language servers send Markdown (or plain text) that may embed HTML tags (Javadoc,
//! PHPDoc). Those tags are converted the way JetBrains' converter does; fenced code is
//! left alone. Unlike an HTML page, the Markdown around the tags keeps its line breaks.

/// Hover contents (`markdown` or `plaintext`) as Markdown.
pub(super) fn to_markdown(kind: &str, value: &str) -> String {
    if kind != "markdown" {
        return value.trim().to_owned();
    }
    let mut out = String::new();
    let mut segment = String::new();
    let mut in_fence = false;
    for line in value.split_inclusive('\n') {
        let fence = line.trim_start().starts_with("```");
        if in_fence {
            out.push_str(line);
            in_fence = !fence;
        } else if fence {
            out.push_str(&convert_segment(&std::mem::take(&mut segment)));
            out.push_str(line);
            in_fence = true;
        } else {
            segment.push_str(line);
        }
    }
    out.push_str(&convert_segment(&segment));
    out.trim().to_owned()
}

fn convert_segment(segment: &str) -> String {
    if has_html(segment) { Converter::default().convert(segment) } else { segment.to_owned() }
}

const TAGS: &[&str] = &[
    "a",
    "b",
    "blockquote",
    "br",
    "code",
    "dd",
    "div",
    "dl",
    "dt",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "input",
    "li",
    "ol",
    "p",
    "pre",
    "s",
    "span",
    "strike",
    "strong",
    "table",
    "td",
    "th",
    "tr",
    "tt",
    "ul",
];

/// Whether `text` holds a tag the converter knows (so `Vec<T>` or `a < b` stay as they are).
fn has_html(text: &str) -> bool {
    let mut rest = text;
    while let Some(i) = rest.find('<') {
        rest = &rest[i + 1..];
        if let Some(Token::Open { .. } | Token::Close(_)) = parse_tag(rest).map(|(t, _)| t) {
            return true;
        }
    }
    false
}

enum Token {
    Open { name: String, attrs: Vec<(String, String)>, self_closing: bool },
    Close(String),
}

/// A known tag right after a `<`, and the bytes it used (up to and including `>`).
fn parse_tag(s: &str) -> Option<(Token, usize)> {
    let end = s.find('>')?;
    let inner = &s[..end];
    let (closing, body) = match inner.strip_prefix('/') {
        Some(b) => (true, b),
        None => (false, inner),
    };
    let name_len = body.find(|c: char| !c.is_ascii_alphanumeric()).unwrap_or(body.len());
    let name = body[..name_len].to_ascii_lowercase();
    if !TAGS.contains(&name.as_str()) {
        return None;
    }
    let rest = &body[name_len..];
    if !rest.is_empty() && !rest.starts_with(|c: char| c.is_whitespace() || c == '/') {
        return None;
    }
    if closing {
        return Some((Token::Close(name), end + 1));
    }
    let self_closing = rest.trim_end().ends_with('/');
    Some((Token::Open { name, attrs: attributes(rest.trim_end().trim_end_matches('/')), self_closing }, end + 1))
}

fn attributes(mut s: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    loop {
        s = s.trim_start();
        let name_len = s.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(s.len());
        if name_len == 0 {
            return out;
        }
        let name = s[..name_len].to_ascii_lowercase();
        s = s[name_len..].trim_start();
        let Some(after) = s.strip_prefix('=') else {
            out.push((name, String::new()));
            continue;
        };
        let after = after.trim_start();
        let (value, rest) = match after.chars().next() {
            Some(q @ ('"' | '\'')) => match after[1..].find(q) {
                Some(close) => (&after[1..1 + close], &after[close + 2..]),
                None => (&after[1..], ""),
            },
            _ => {
                let len = after.find(char::is_whitespace).unwrap_or(after.len());
                (&after[..len], &after[len..])
            }
        };
        out.push((name, decode_entities(value)));
        s = rest;
    }
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let decoded = rest.find(';').filter(|end| *end <= 10).and_then(|end| {
            let entity = &rest[1..end];
            let c = match entity {
                "lt" => Some('<'),
                "gt" => Some('>'),
                "amp" => Some('&'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ => entity
                    .strip_prefix("#x")
                    .or_else(|| entity.strip_prefix("#X"))
                    .and_then(|h| u32::from_str_radix(h, 16).ok())
                    .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                    .and_then(char::from_u32),
            };
            c.map(|c| (c, end + 1))
        });
        match decoded {
            Some((c, len)) => {
                out.push(c);
                rest = &rest[len..];
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

/// JetBrains' `HtmlToMarkdownConverter` callback, driven by a small tag scanner.
#[derive(Default)]
struct Converter {
    md: String,
    /// 0 for a bullet list, else the next number.
    lists: Vec<u32>,
    in_pre: u32,
    in_blockquote: usize,
    rows: u32,
    cells_in_row: u32,
    trim_next_indent: bool,
    href: String,
    /// Closing text owed by open tags (`</span>` for colored text).
    terminators: Vec<String>,
}

impl Converter {
    fn convert(mut self, html: &str) -> String {
        let mut rest = html;
        while !rest.is_empty() {
            match rest.find('<') {
                Some(i) => {
                    self.text(&rest[..i]);
                    let after = &rest[i + 1..];
                    if let Some(comment) = after.strip_prefix("!--") {
                        rest = comment.find("-->").map_or("", |end| &comment[end + 3..]);
                        continue;
                    }
                    match parse_tag(after) {
                        Some((token, len)) => {
                            self.tag(token);
                            rest = &after[len..];
                        }
                        None => {
                            self.text("<");
                            rest = after;
                        }
                    }
                }
                None => {
                    self.text(rest);
                    rest = "";
                }
            }
        }
        self.md
    }

    fn line_end(&self) -> String {
        format!("\n{}", "> ".repeat(self.in_blockquote))
    }

    fn new_line(&mut self) {
        let end = self.line_end();
        self.md.push_str(&end);
    }

    fn new_line_if_needed(&mut self) {
        let end = self.line_end();
        if !self.md.is_empty() && !self.md.ends_with(&end) && !self.md.ends_with('\n') {
            self.md.push_str(&end);
        }
    }

    fn line_separator(&mut self) {
        let end = self.line_end();
        if !self.md.is_empty() && !self.md.ends_with(&format!("{end}{end}")) {
            self.md.push_str(&end);
        }
    }

    fn text(&mut self, raw: &str) {
        if raw.is_empty() {
            return;
        }
        let mut text = decode_entities(raw);
        if self.in_pre == 0 {
            text = collapse_spaces(&text);
        }
        if self.trim_next_indent {
            text = text.trim_start().to_owned();
            self.trim_next_indent = false;
        }
        self.md.push_str(&text);
    }

    fn tag(&mut self, token: Token) {
        match token {
            Token::Open { name, attrs, self_closing } => {
                let attr = |key: &str| attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
                if matches!(name.as_str(), "br" | "img" | "input" | "hr") || self_closing {
                    self.simple_tag(&name, &attr);
                    return;
                }
                self.start_tag(&name, &attr);
                let mut terminator = String::new();
                if let Some(color) = attr("color") {
                    self.md.push_str(&format!("<span style=\"color:{color}\">"));
                    terminator.push_str("</span>");
                }
                self.terminators.push(terminator);
            }
            Token::Close(name) => {
                if matches!(name.as_str(), "br" | "img" | "input" | "hr") {
                    return;
                }
                if let Some(t) = self.terminators.pop() {
                    self.md.push_str(&t);
                }
                self.end_tag(&name);
            }
        }
    }

    fn simple_tag(&mut self, name: &str, attr: &dyn Fn(&str) -> Option<String>) {
        match name {
            "br" => self.new_line(),
            "hr" => {
                self.new_line_if_needed();
                self.md.push_str("---");
                self.new_line();
            }
            "img" => {
                if let Some(src) = attr("src") {
                    let alt = attr("alt").unwrap_or_default();
                    self.md.push_str(&format!("![{alt}]({src})"));
                }
            }
            "input" if attr("type").is_some_and(|t| t.eq_ignore_ascii_case("checkbox")) => {
                if !self.md.is_empty() && !self.md.ends_with(' ') {
                    self.md.push(' ');
                }
                self.md.push_str(if attr("checked").is_some() { "[x] " } else { "[ ] " });
                self.trim_next_indent = true;
            }
            _ => {}
        }
    }

    fn start_tag(&mut self, name: &str, attr: &dyn Fn(&str) -> Option<String>) {
        match name {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                self.new_line_if_needed();
                let level = name[1..].parse::<usize>().unwrap_or(1);
                self.md.push_str(&format!("{} ", "#".repeat(level)));
            }
            "b" | "strong" => self.md.push_str("**"),
            "i" | "em" => self.md.push('_'),
            "s" | "strike" => self.md.push_str("~~"),
            "p" | "div" | "dl" | "dt" => {
                if self.lists.is_empty() {
                    self.new_line_if_needed();
                }
            }
            "dd" => {
                self.new_line_if_needed();
                self.md.push_str("    ");
                self.trim_next_indent = true;
            }
            "ul" => self.lists.push(0),
            "ol" => self.lists.push(1),
            "li" => {
                if let Some(order) = self.lists.pop() {
                    self.new_line_if_needed();
                    self.md.push_str(&"    ".repeat(self.lists.len()));
                    if order == 0 {
                        self.md.push_str("- ");
                        self.lists.push(0);
                    } else {
                        self.md.push_str(&format!("{order}. "));
                        self.lists.push(order + 1);
                    }
                    self.trim_next_indent = true;
                }
            }
            "pre" => self.in_pre += 1,
            "code" | "tt" => {
                if self.in_pre > 0 {
                    self.new_line_if_needed();
                    self.md.push_str("```");
                    self.new_line();
                } else {
                    self.md.push('`');
                }
                self.in_pre += 1;
            }
            "a" => {
                self.href = attr("href").unwrap_or_default();
                self.md.push('[');
            }
            "blockquote" => {
                self.in_blockquote += 1;
                self.new_line();
            }
            "table" => {
                self.rows = 0;
                self.cells_in_row = 0;
                self.new_line_if_needed();
                self.new_line();
            }
            "tr" => {
                self.rows += 1;
                self.cells_in_row = 0;
                self.new_line_if_needed();
            }
            "td" | "th" => {
                self.cells_in_row += 1;
                self.md.push_str("| ");
                self.trim_next_indent = true;
            }
            _ => {}
        }
    }

    fn end_tag(&mut self, name: &str) {
        match name {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "div" | "li" | "table" | "dt" | "dd" => {
                self.new_line_if_needed()
            }
            "b" | "strong" => self.md.push_str("**"),
            "i" | "em" => self.md.push('_'),
            "s" | "strike" => self.md.push_str("~~"),
            "a" => {
                let href = std::mem::take(&mut self.href);
                self.md.push_str(&format!("]({href})"));
            }
            "blockquote" => {
                self.in_blockquote = self.in_blockquote.saturating_sub(1);
                self.new_line();
                self.new_line();
            }
            "ul" | "ol" | "dl" => {
                if name != "dl" {
                    self.lists.pop();
                }
                self.line_separator();
            }
            "pre" => self.in_pre = self.in_pre.saturating_sub(1),
            "code" | "tt" => {
                self.in_pre = self.in_pre.saturating_sub(1);
                if self.in_pre > 0 {
                    self.new_line_if_needed();
                    self.md.push_str("```");
                    self.new_line();
                } else {
                    self.md.push('`');
                }
            }
            "tr" => {
                self.md.push('|');
                self.new_line();
                if self.rows == 1 && self.cells_in_row > 0 {
                    self.md.push_str(&"| --- ".repeat(self.cells_in_row as usize));
                    self.md.push('|');
                    self.new_line();
                }
            }
            "td" | "th" => {
                self.md.push(' ');
                self.trim_next_indent = true;
            }
            _ => {}
        }
    }
}

/// Runs of spaces and tabs as one space; line breaks stay (the Markdown around the tags needs them).
fn collapse_spaces(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if c == ' ' || c == '\t' {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_embedded_html() {
        let md = to_markdown(
            "markdown",
            "```java\nList<String> parse(String s)\n```\nParses <b>it</b>.<p>See <a href=\"https://x\">docs</a> \
and <code>Vec&lt;T&gt;</code>.\n<ul><li>one</li><li>two</li></ul>",
        );
        assert_eq!(
            md,
            "```java\nList<String> parse(String s)\n```\nParses **it**.\nSee [docs](https://x) and `Vec<T>`.\n- one\n- two"
        );
    }

    #[test]
    fn leaves_plain_markdown_alone() {
        let text = "fn f<T>(x: Vec<T>) -> bool\n\nReturns `a < b`.";
        assert_eq!(to_markdown("markdown", text), text);
        assert_eq!(to_markdown("plaintext", "  <b>x</b> \n"), "<b>x</b>");
    }

    #[test]
    fn converts_blocks() {
        assert_eq!(to_markdown("markdown", "<pre><code>a  b\n c</code></pre>"), "```\na  b\n c\n```");
        assert_eq!(
            to_markdown("markdown", "<table><tr><th>K</th><th>V</th></tr><tr><td>a</td><td>1</td></tr></table>"),
            "| K | V |\n| --- | --- |\n| a | 1 |"
        );
        assert_eq!(to_markdown("markdown", "<ol><li>x</li><li>y</li></ol>"), "1. x\n2. y");
        assert_eq!(to_markdown("markdown", "a<br/>b &amp; <i>c</i>"), "a\nb & _c_");
    }
}
