//! Words worth spell checking in a region of source text, IDEA style:
//! identifiers split at `camelCase` / `snake_case` boundaries; URLs, e-mail
//! addresses, escapes, hex, acronyms, short tokens and tokens with digits skipped.

use crate::RegionKind;

/// Shorter words are never checked.
pub const MIN_WORD_CHARS: usize = 3;

/// Byte range of a word in the text the region came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WordSpan {
    pub start: usize,
    pub end: usize,
}

/// Words of `text[start..end]` in order, as absolute byte ranges.
pub fn words(text: &str, start: usize, end: usize, kind: RegionKind, out: &mut Vec<WordSpan>) {
    let Some(slice) = text.get(start..end) else { return };
    let escapes = match kind {
        RegionKind::Name => Escapes::None,
        RegionKind::String => Escapes::Char,
        RegionKind::Comment | RegionKind::Prose => Escapes::Word,
    };
    let mut chunk_start = None;
    for (i, c) in slice.char_indices().chain(std::iter::once((slice.len(), ' '))) {
        if c.is_whitespace() {
            if let Some(s) = chunk_start.take() {
                chunk(slice, s, i, escapes, start, out);
            }
        } else if chunk_start.is_none() {
            chunk_start = Some(i);
        }
    }
}

/// What a `\` hides from the spell checker.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Escapes {
    /// Identifiers have no escapes.
    None,
    /// String literals: the escape letter (`\n`, `\t`), the rest of the word is text.
    Char,
    /// Comments and prose: the whole word, a Doxygen / TeX command (`\brief`,
    /// `\param`) or an escape quoted in a comment (`\n`).
    Word,
}

/// URLs, e-mail addresses and the like are not prose.
fn skip_chunk(chunk: &str) -> bool {
    if chunk.contains("://") || chunk.starts_with("www.") {
        return true;
    }
    match chunk.find('@') {
        Some(at) => chunk[at + 1..].contains('.') && at > 0,
        None => false,
    }
}

fn chunk(slice: &str, from: usize, to: usize, escapes: Escapes, base: usize, out: &mut Vec<WordSpan>) {
    let text = &slice[from..to];
    if skip_chunk(text) {
        return;
    }
    let mut run: Option<usize> = None;
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        let word_char = c.is_alphanumeric() || c == '_' || c == '\'';
        if word_char {
            run.get_or_insert(i);
            continue;
        }
        if let Some(s) = run.take() {
            token(text, s, i, base + from, out);
        }
        if c == '\\' {
            match escapes {
                Escapes::None => {}
                // `\n`, `\t`, `é`: the escape letter is not part of the next word.
                Escapes::Char => {
                    chars.next();
                }
                Escapes::Word => while chars.next_if(|&(_, c)| c.is_alphanumeric() || c == '_').is_some() {},
            }
        }
    }
    if let Some(s) = run {
        token(text, s, text.len(), base + from, out);
    }
}

/// One alphanumeric run (`parseHTMLDoc`, `max_len`, `don't`).
fn token(text: &str, mut s: usize, mut e: usize, base: usize, out: &mut Vec<WordSpan>) {
    let trim = |c: char| c == '\'' || c == '_';
    while s < e && text[s..e].starts_with(trim) {
        s += 1;
    }
    while e > s && text[s..e].ends_with(trim) {
        e -= 1;
    }
    let tok = &text[s..e];
    if tok.is_empty() || tok.chars().any(|c| c.is_ascii_digit()) {
        return;
    }
    if tok.len() >= 6 && tok.chars().all(|c| c.is_ascii_hexdigit()) {
        return;
    }
    for (ps, pe) in pieces(tok) {
        let w = &tok[ps..pe];
        let w = w.trim_matches('\'');
        if w.is_empty() {
            continue;
        }
        let ws = s + ps + tok[ps..pe].find(w).unwrap_or(0);
        if checkable(w) {
            out.push(WordSpan { start: base + ws, end: base + ws + w.len() });
        }
    }
}

/// `snake_case` and `camelCase` / `HTTPServer` pieces of a token.
fn pieces(tok: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut offset = 0;
    for part in tok.split('_') {
        let chars: Vec<(usize, char)> = part.char_indices().collect();
        let mut start = 0;
        for k in 1..chars.len() {
            let (i, c) = chars[k];
            let prev = chars[k - 1].1;
            let next_lower = chars.get(k + 1).is_some_and(|&(_, n)| n.is_lowercase());
            let boundary =
                (prev.is_lowercase() && c.is_uppercase()) || (prev.is_uppercase() && c.is_uppercase() && next_lower);
            if boundary {
                out.push((offset + start, offset + i));
                start = i;
            }
        }
        if !part.is_empty() {
            out.push((offset + start, offset + part.len()));
        }
        offset += part.len() + 1;
    }
    out
}

/// Long enough, not an acronym, and in a script the bundled dictionary covers.
fn checkable(w: &str) -> bool {
    let letters = w.chars().filter(|c| c.is_alphabetic()).count();
    if letters < MIN_WORD_CHARS {
        return false;
    }
    if !w.chars().any(|c| c.is_lowercase()) {
        return false;
    }
    // Latin letters only (through Latin Extended-B): CJK, Cyrillic, … are not checked.
    w.chars().all(|c| c == '\'' || (c.is_alphabetic() && (c as u32) < 0x250))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(text: &str, kind: RegionKind) -> Vec<&str> {
        let mut out = Vec::new();
        words(text, 0, text.len(), kind, &mut out);
        out.into_iter().map(|w| &text[w.start..w.end]).collect()
    }

    #[test]
    fn splits_identifiers() {
        assert_eq!(split("parseHTMLDocument", RegionKind::Name), ["parse", "Document"]);
        assert_eq!(split("max_line_length", RegionKind::Name), ["max", "line", "length"]);
        assert_eq!(split("getUserName", RegionKind::Name), ["get", "User", "Name"]);
        assert_eq!(split("XMLHttpRequest", RegionKind::Name), ["Http", "Request"]);
    }

    #[test]
    fn skips_noise() {
        assert_eq!(
            split("see https://exmple.com/foo or mail me@exmple.org, id 0xdeadbeef v2beta", RegionKind::Comment),
            ["see", "mail"]
        );
        assert_eq!(split("deadbeefcafe NASA ok", RegionKind::Comment), Vec::<&str>::new());
        assert_eq!(split("\"line\\nbreak\\twith tab\"", RegionKind::String), ["line", "break", "with", "tab"]);
        assert_eq!(split("// 中文注释 naïve", RegionKind::Comment), ["naïve"]);
    }

    #[test]
    fn skips_backslash_commands_in_comments() {
        assert_eq!(split("/// \\brief Returns the sum.", RegionKind::Comment), ["Returns", "the", "sum"]);
        assert_eq!(split("@see \\ref Foo, \\param[in] count", RegionKind::Comment), ["see", "Foo", "count"]);
        assert_eq!(split("prints \\nthe line", RegionKind::Comment), ["prints", "line"]);
        assert_eq!(split("\\emph{word} text", RegionKind::Prose), ["word", "text"]);
    }

    #[test]
    fn keeps_apostrophes_inside_words() {
        assert_eq!(split("'don't' shouldn't", RegionKind::Comment), ["don't", "shouldn't"]);
    }
}
