//! Match iteration that never splits a UTF-8 sequence after an empty match
//! (`grep-matcher`'s iterators advance by a single byte), and that applies
//! IDEA's whole-word rule.

use grep_matcher::{Captures, Match, Matcher};
use grep_regex::{RegexCaptures, RegexMatcher};

/// Calls `f` for each non-overlapping match in `haystack[at..]`; `haystack[..at]`
/// is only used as look-behind context. With `whole_word`, only [`is_whole_word`] matches.
pub(crate) fn for_each_match(
    matcher: &RegexMatcher,
    whole_word: bool,
    haystack: &[u8],
    at: usize,
    mut f: impl FnMut(Match),
) {
    let mut at = at;
    let mut last_end = None;
    while at <= haystack.len() {
        let Ok(Some(m)) = matcher.find_at(haystack, at) else { break };
        if whole_word && !is_whole_word(haystack, m) {
            at = next_char(haystack, m.start());
            continue;
        }
        at = advance(haystack, m);
        if m.is_empty() && last_end == Some(m.end()) {
            continue;
        }
        last_end = Some(m.end());
        f(m);
    }
}

/// Like [`for_each_match`] but with capture groups.
pub(crate) fn for_each_captures(
    matcher: &RegexMatcher,
    whole_word: bool,
    haystack: &[u8],
    caps: &mut RegexCaptures,
    mut f: impl FnMut(&RegexCaptures),
) {
    let mut at = 0;
    let mut last_end = None;
    while at <= haystack.len() {
        if !matches!(matcher.captures_at(haystack, at, caps), Ok(true)) {
            break;
        }
        let Some(m) = caps.get(0) else { break };
        if whole_word && !is_whole_word(haystack, m) {
            at = next_char(haystack, m.start());
            continue;
        }
        at = advance(haystack, m);
        if m.is_empty() && last_end == Some(m.end()) {
            continue;
        }
        last_end = Some(m.end());
        f(caps);
    }
}

/// Where to resume after `m`: its end, or past the next char for empty matches.
fn advance(haystack: &[u8], m: Match) -> usize {
    if !m.is_empty() { m.end() } else { next_char(haystack, m.end()) }
}

/// The start of the char after the one at `at`.
fn next_char(haystack: &[u8], at: usize) -> usize {
    let mut next = at + 1;
    while next < haystack.len() && (haystack[next] & 0xC0) == 0x80 {
        next += 1;
    }
    next
}

/// IDEA's whole word (`FindManagerBase.isWholeWord`): an edge where the match has an
/// identifier character must not touch another one, unless it follows an escape such as
/// `\n`; an edge with another character only must not repeat that character (`==` is not
/// in `===`).
fn is_whole_word(haystack: &[u8], m: Match) -> bool {
    let (start, end) = (m.start(), m.end());
    let word_start = match (char_before(haystack, start), char_at(haystack, start)) {
        (Some(prev), Some(first)) if is_identifier(first) => {
            let escaped = char_before(haystack, start - prev.len_utf8()) == Some('\\');
            !is_identifier(prev) || escaped
        }
        (Some(prev), Some(first)) => prev != first,
        _ => true,
    };
    let word_end = match (char_at(haystack, end), char_before(haystack, end)) {
        (Some(next), Some(last)) if is_identifier(last) => !is_identifier(next),
        (Some(next), Some(last)) => next != last,
        (Some(_), None) | (None, _) => true,
    };
    word_start && word_end
}

/// Java's identifier part, near enough: letters, digits, `_` and `$`.
fn is_identifier(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// The char starting at byte `at` (`None` at the end or in invalid UTF-8).
fn char_at(haystack: &[u8], at: usize) -> Option<char> {
    let rest = haystack.get(at..)?;
    let len = rest.len().min(4);
    let s = match std::str::from_utf8(&rest[..len]) {
        Ok(s) => s,
        Err(e) => std::str::from_utf8(&rest[..e.valid_up_to()]).ok()?,
    };
    s.chars().next()
}

/// The char ending at byte `at` (`None` at the start or in invalid UTF-8).
fn char_before(haystack: &[u8], at: usize) -> Option<char> {
    let head = haystack.get(..at)?;
    let from = head.len().saturating_sub(4);
    (from..head.len()).find_map(|i| std::str::from_utf8(&head[i..]).ok().and_then(|s| s.chars().next_back()))
}
