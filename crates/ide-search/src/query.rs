//! Compiles a [`SearchQuery`] into a ripgrep matcher.

use crate::SearchQuery;
use grep_matcher::LineTerminator;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use ide_core::{IdeError, IdeResult};

/// A compiled query: the matcher plus whether matches may span lines.
pub(crate) struct Compiled {
    pub matcher: RegexMatcher,
    pub multi_line: bool,
    /// Keep only whole-word matches ([`crate::iter`] checks IDEA's rule on each match).
    pub whole_word: bool,
}

/// The line terminator shared by the matcher and the searcher. CRLF mode lets
/// `$` match before `\r\n` and keeps `\r` out of single-line matches.
pub(crate) fn line_terminator() -> LineTerminator {
    LineTerminator::crlf()
}

pub(crate) fn compile(query: &SearchQuery) -> IdeResult<Compiled> {
    let multi_line = needs_multi_line(query);
    let whole_word = query.whole_word;
    match build(query, multi_line) {
        Ok(matcher) => Ok(Compiled { matcher, multi_line, whole_word }),
        // Patterns such as `[\n]` or `\x0A` can only match across lines;
        // retry in multi-line mode before reporting an error.
        Err(err) if !multi_line => match build(query, true) {
            Ok(matcher) => Ok(Compiled { matcher, multi_line: true, whole_word }),
            Err(_) => Err(invalid_pattern(query, &err)),
        },
        Err(err) => Err(invalid_pattern(query, &err)),
    }
}

fn build(query: &SearchQuery, multi_line: bool) -> Result<RegexMatcher, grep_regex::Error> {
    let mut b = RegexMatcherBuilder::new();
    b.case_smart(false)
        .case_insensitive(!query.case_sensitive)
        // Not `.word()`: ripgrep's rule wants a non-word character on both sides even of
        // `foo(`, IDEA's (in `iter`) only beside the match's identifier characters.
        .fixed_strings(!query.is_regex)
        .unicode(true)
        // `^`/`$` always mean start/end of line, as in IDEA and ripgrep.
        .multi_line(true)
        .dot_matches_new_line(false)
        .crlf(true);
    if multi_line {
        // Must come after `crlf`, which sets a line terminator.
        b.line_terminator(None);
    }
    b.build(&query.pattern)
}

fn invalid_pattern(query: &SearchQuery, err: &grep_regex::Error) -> IdeError {
    let reason = short_reason(&err.to_string());
    if query.is_regex {
        IdeError::invalid(format!("Invalid regular expression: {reason}"))
    } else {
        IdeError::invalid(format!("Invalid search string: {reason}"))
    }
}

/// The regex crate reports a multi-line diagnostic quoting the pattern as the
/// builder rewrote it (`(?:…)`); the UI shows one line, so keep the reason.
fn short_reason(message: &str) -> String {
    message.lines().rev().find_map(|l| l.trim().strip_prefix("error: ")).unwrap_or(message.trim()).to_string()
}

/// Multi-line search is enabled when the pattern itself contains a newline or,
/// for regexes, an unescaped `\n`.
fn needs_multi_line(query: &SearchQuery) -> bool {
    if query.pattern.contains('\n') {
        return true;
    }
    if !query.is_regex {
        return false;
    }
    let mut chars = query.pattern.chars();
    while let Some(c) = chars.next() {
        if c == '\\' && chars.next() == Some('n') {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SearchScope;

    fn q(pattern: &str, is_regex: bool) -> SearchQuery {
        SearchQuery {
            pattern: pattern.into(),
            is_regex,
            case_sensitive: false,
            whole_word: false,
            include: vec![],
            exclude: vec![],
            scope: SearchScope::Project,
            max_matches: 0,
            context: Default::default(),
            include_excluded: false,
        }
    }

    #[test]
    fn multi_line_detection() {
        assert!(needs_multi_line(&q("a\nb", false)));
        assert!(!needs_multi_line(&q("a\\nb", false)));
        assert!(needs_multi_line(&q("a\\nb", true)));
        assert!(!needs_multi_line(&q("a\\\\nb", true)));
        assert!(compile(&q("a[\\n]b", true)).unwrap().multi_line);
        assert!(!compile(&q("a\\sb", true)).unwrap().multi_line);
    }

    #[test]
    fn invalid_regex_is_invalid_input() {
        let err = compile(&q("foo(", true)).err().unwrap();
        assert_eq!(err.kind, ide_core::error::ErrorKind::InvalidInput);
        assert_eq!(err.message, "Invalid regular expression: unclosed group");
        assert!(compile(&q("foo(", false)).is_ok());
    }
}
