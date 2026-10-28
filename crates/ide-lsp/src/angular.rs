//! The Angular Language Server next to vtsls in TypeScript files, asked like
//! VS Code's Angular extension asks it: about positions only inside a
//! component's template and styles, since it answers nothing elsewhere and
//! answers late while it analyses the project.

pub(crate) const SERVER: &str = "angular-language-server";

/// Decorator fields holding templates, styles and host bindings.
const PROPERTIES: [&str; 6] = ["template", "templateUrl", "styles", "styleUrls", "styleUrl", "host"];
/// Decorators taking host bindings as string arguments.
const DECORATORS: [&str; 2] = ["HostBinding", "HostListener"];

/// Whether the Angular server is asked about the position at byte `offset` of
/// a `language` document: anywhere in a template file, in TypeScript only in
/// a string of a decorator field.
pub(crate) fn serves_position(language: &str, text: &str, offset: usize) -> bool {
    language != "typescript" || in_decorator_field(text, offset)
}

/// Whether the Angular server is asked for the inlay hints of a `language`
/// document: in TypeScript only with Angular imported.
pub(crate) fn serves_inlay_hints(language: &str, text: &str) -> bool {
    language != "typescript" || text.contains("@angular/core")
}

/// Whether byte `offset` is inside a string of one of [`PROPERTIES`] (`template:
/// '...'`, `styles: ['...']`) or of an argument of one of [`DECORATORS`]. A
/// port of the VS Code extension's token scan: false positives are fine, the
/// server has the last word.
fn in_decorator_field(text: &str, offset: usize) -> bool {
    let mut scanner = Scanner { text: text.as_bytes(), pos: 0, braces: 0, substitutions: Vec::new() };
    let (mut last, mut second_last, mut last_text) = (None, None, "");
    let (mut braces, mut brackets, mut parens) = (0i32, 0i32, 0i32);
    // The brace and bracket depth of the property whose value is being read.
    let mut property: Option<(i32, i32)> = None;
    // The paren depth of the decorator whose arguments are being read.
    let mut decorator: Option<i32> = None;
    while let Some((tok, start, end)) = scanner.next() {
        if start >= offset {
            break;
        }
        if last == Some(Tok::Ident) && tok == Tok::Colon && PROPERTIES.contains(&last_text) {
            property = Some((braces, brackets));
            continue;
        }
        if property == Some((braces, brackets)) && matches!(tok, Tok::Comma | Tok::Semicolon | Tok::CloseBrace) {
            property = None;
        }
        if second_last == Some(Tok::At)
            && last == Some(Tok::Ident)
            && tok == Tok::OpenParen
            && DECORATORS.contains(&last_text)
        {
            decorator = Some(parens);
        }
        if tok == Tok::CloseParen && decorator == Some(parens - 1) {
            decorator = None;
        }
        match tok {
            Tok::OpenBrace => braces += 1,
            Tok::CloseBrace => braces -= 1,
            Tok::OpenBracket => brackets += 1,
            Tok::CloseBracket => brackets -= 1,
            Tok::OpenParen => parens += 1,
            Tok::CloseParen => parens -= 1,
            _ => {}
        }
        if (property.is_some() || decorator.is_some()) && tok == Tok::Str && offset <= end {
            return true;
        }
        last_text = text.get(start..end).unwrap_or("");
        second_last = last;
        last = Some(tok);
    }
    false
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tok {
    Ident,
    Colon,
    Comma,
    Semicolon,
    At,
    OpenBrace,
    CloseBrace,
    OpenBracket,
    CloseBracket,
    OpenParen,
    CloseParen,
    /// A string or a template literal without substitutions.
    Str,
    /// A part of a template literal with substitutions (`` `a${`` / `}b${` / `` }c` ``).
    Template,
    Other,
}

/// TypeScript tokens, enough to tell strings, names and brackets apart.
/// Like the TypeScript scanner without its parser, `/` is never a regex.
struct Scanner<'a> {
    text: &'a [u8],
    pos: usize,
    /// Open `{`, not counting those of template substitutions.
    braces: usize,
    /// The brace depth each open `${` started at, innermost last.
    substitutions: Vec<usize>,
}

impl Scanner<'_> {
    /// The next token and its byte range.
    fn next(&mut self) -> Option<(Tok, usize, usize)> {
        self.skip_trivia();
        let start = self.pos;
        let c = *self.text.get(start)?;
        self.pos += 1;
        let tok = match c {
            b'\'' | b'"' => {
                self.string(c);
                Tok::Str
            }
            b'`' => {
                if self.template() {
                    Tok::Template
                } else {
                    Tok::Str
                }
            }
            b'{' => {
                self.braces += 1;
                Tok::OpenBrace
            }
            // The end of a substitution: the template literal goes on.
            b'}' if self.substitutions.last() == Some(&self.braces) => {
                self.substitutions.pop();
                self.template();
                Tok::Template
            }
            b'}' => {
                self.braces = self.braces.saturating_sub(1);
                Tok::CloseBrace
            }
            b'[' => Tok::OpenBracket,
            b']' => Tok::CloseBracket,
            b'(' => Tok::OpenParen,
            b')' => Tok::CloseParen,
            b':' => Tok::Colon,
            b',' => Tok::Comma,
            b';' => Tok::Semicolon,
            b'@' => Tok::At,
            c if is_ident(c) => {
                while self.text.get(self.pos).is_some_and(|&c| is_ident(c)) {
                    self.pos += 1;
                }
                if c.is_ascii_digit() { Tok::Other } else { Tok::Ident }
            }
            _ => Tok::Other,
        };
        Some((tok, start, self.pos))
    }

    fn skip_trivia(&mut self) {
        loop {
            match (self.text.get(self.pos), self.text.get(self.pos + 1)) {
                (Some(c), _) if c.is_ascii_whitespace() => self.pos += 1,
                (Some(b'/'), Some(b'/')) => {
                    while self.text.get(self.pos).is_some_and(|&c| c != b'\n') {
                        self.pos += 1;
                    }
                }
                (Some(b'/'), Some(b'*')) => {
                    self.pos += 2;
                    while self.pos < self.text.len() && !self.text[self.pos..].starts_with(b"*/") {
                        self.pos += 1;
                    }
                    self.pos = (self.pos + 2).min(self.text.len());
                }
                _ => return,
            }
        }
    }

    /// The rest of a string opened by `quote`, which a line break ends too.
    fn string(&mut self, quote: u8) {
        while let Some(&c) = self.text.get(self.pos) {
            self.pos += if c == b'\\' { 2 } else { 1 };
            if c == quote || c == b'\n' {
                break;
            }
        }
        self.pos = self.pos.min(self.text.len());
    }

    /// The rest of a template literal part; `true` when a substitution opens it.
    fn template(&mut self) -> bool {
        while let Some(&c) = self.text.get(self.pos) {
            match c {
                b'\\' => self.pos += 2,
                b'`' => {
                    self.pos += 1;
                    return false;
                }
                b'$' if self.text.get(self.pos + 1) == Some(&b'{') => {
                    self.pos += 2;
                    self.substitutions.push(self.braces);
                    return true;
                }
                _ => self.pos += 1,
            }
        }
        self.pos = self.pos.min(self.text.len());
        false
    }
}

/// Identifier bytes; any non-ASCII byte belongs to one too.
fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Whether the position marked `|` in `src` is in a decorator field.
    fn at_marker(src: &str) -> bool {
        let offset = src.find('|').expect("marker");
        in_decorator_field(&src.replacen('|', "", 1), offset)
    }

    #[test]
    fn template_and_style_strings_are_decorator_fields() {
        assert!(at_marker("@Component({ selector: 'a', template: `<p>{{ |x }}</p>` })"));
        assert!(at_marker("@Component({\n  template: '<p>|</p>',\n})"));
        assert!(at_marker("@Component({ templateUrl: './a.|html' })"));
        assert!(at_marker("@Component({ styles: ['p {}', 'a { |}'] })"));
        assert!(at_marker("@Component({ host: { '(click)': 'on|Click()' } })"));
        assert!(at_marker("class A { @HostListener('click', ['$event.|target']) on() {} }"));
        // Still being typed: the string runs to the end of the line.
        assert!(at_marker("@Component({ template: '<p>|"));
    }

    #[test]
    fn code_and_other_strings_are_not() {
        assert!(!at_marker("@Component({ selector: 'app-|root', template: '' })"));
        assert!(!at_marker("@Component({ template: '' })\nclass A { t|itle = 'x'; }"));
        assert!(!at_marker("@Component({ template: '' })\nclass A { title = '|x'; }"));
        assert!(!at_marker("@Component({ template: |`<p></p>` })"));
        assert!(!at_marker("@Component({ template: '', imports: [A|] })"));
        assert!(!at_marker("class A { @HostListener('click') on() { const s = '|'; } }"));
        assert!(!at_marker("// template: '|'\nclass A {}"));
        assert!(!at_marker("/* template: '|' */"));
    }

    #[test]
    fn substitutions_dont_end_template_literals() {
        // `}` closing `${...}` is not the end of the object holding `template`.
        assert!(at_marker("const a = `${ {b: 1} }`;\n@Component({ template: '<p>|</p>' })"));
        assert!(!at_marker("@Component({ template: `<p>${x}|</p>` })"));
        assert!(at_marker("const s = `${'}'}`; @Component({ template: '<i>|</i>' })"));
        assert!(!at_marker("const s = `${`${'a'}`}`; class A { b = '|'; }"));
    }

    #[test]
    fn typescript_positions_go_to_angular_only_in_decorator_fields() {
        let src = "@Component({ template: '<p></p>' })\nclass A {}";
        assert!(serves_position("html", src, src.find("class").unwrap()));
        assert!(!serves_position("typescript", src, src.find("class").unwrap()));
        assert!(serves_position("typescript", src, src.find("</p>").unwrap()));
        assert!(serves_inlay_hints("typescript", "import { Component } from '@angular/core';"));
        assert!(!serves_inlay_hints("typescript", "export const a = 1;"));
        assert!(serves_inlay_hints("html", ""));
    }
}
