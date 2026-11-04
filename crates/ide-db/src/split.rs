//! Splitting SQL scripts into statements (`;`-terminated), aware of string
//! literals, quoted identifiers, comments and PostgreSQL dollar quoting.
//! Offsets are UTF-16 code units, like everything on the IPC boundary.

use crate::DbDriver;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SqlStatement {
    /// UTF-16 offsets of the statement text (whitespace trimmed, `;` excluded).
    pub from: u32,
    pub to: u32,
    pub text: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Code,
    Single,
    Double,
    Backtick,
    LineComment,
    BlockComment,
}

/// Every statement of `text` that contains more than whitespace and comments.
pub fn split(text: &str, driver: DbDriver) -> Vec<SqlStatement> {
    let mysql = driver == DbDriver::Mysql;
    let clickhouse = driver == DbDriver::Clickhouse;
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    // UTF-16 offset of each char index (plus the end).
    let mut u16_at = Vec::with_capacity(chars.len() + 1);
    let mut u = 0u32;
    for &(_, c) in &chars {
        u16_at.push(u);
        u += c.len_utf16() as u32;
    }
    u16_at.push(u);
    let byte_at = |i: usize| chars.get(i).map_or(text.len(), |c| c.0);

    let mut out = Vec::new();
    let mut state = State::Code;
    let mut start = 0usize;
    // Whether the current segment has anything but whitespace / comments.
    let mut has_code = false;
    let mut i = 0usize;
    let push = |out: &mut Vec<SqlStatement>, s: usize, e: usize, has_code: bool| {
        if !has_code {
            return;
        }
        let seg = &text[byte_at(s)..byte_at(e)];
        let lead = seg.len() - seg.trim_start().len();
        let trimmed = seg.trim();
        if trimmed.is_empty() {
            return;
        }
        let lead_chars = seg[..lead].chars().count();
        let len_chars = trimmed.chars().count();
        out.push(SqlStatement {
            from: u16_at[s + lead_chars],
            to: u16_at[s + lead_chars + len_chars],
            text: trimmed.to_owned(),
        });
    };
    while i < chars.len() {
        let c = chars[i].1;
        let next = chars.get(i + 1).map(|c| c.1);
        match state {
            State::Code => match c {
                ';' => {
                    push(&mut out, start, i, has_code);
                    start = i + 1;
                    has_code = false;
                }
                '\'' => {
                    state = State::Single;
                    has_code = true;
                }
                '"' => {
                    state = State::Double;
                    has_code = true;
                }
                '`' if mysql || clickhouse => {
                    state = State::Backtick;
                    has_code = true;
                }
                '-' if next == Some('-') => {
                    state = State::LineComment;
                    i += 1;
                }
                '#' if mysql => state = State::LineComment,
                '/' if next == Some('*') => {
                    state = State::BlockComment;
                    i += 1;
                }
                '$' if driver == DbDriver::Postgres => {
                    // `$tag$ … $tag$` (tag may be empty); `$1` parameters are not quotes.
                    let rest = &text[byte_at(i)..];
                    let tag_len = rest[1..].find('$').filter(|&n| {
                        rest[1..1 + n].chars().all(|c| c.is_alphanumeric() || c == '_')
                            && !rest[1..1 + n].starts_with(|c: char| c.is_ascii_digit())
                    });
                    has_code = true;
                    if let Some(n) = tag_len {
                        let tag = &rest[..n + 2];
                        let body_start = byte_at(i) + tag.len();
                        let close = text[body_start..].find(tag).map_or(text.len(), |p| body_start + p + tag.len());
                        // Jump to the char at byte `close`.
                        while i < chars.len() && chars[i].0 < close {
                            i += 1;
                        }
                        continue;
                    }
                }
                c if !c.is_whitespace() => has_code = true,
                _ => {}
            },
            State::Single => {
                if (mysql || clickhouse) && c == '\\' {
                    i += 1;
                } else if c == '\'' {
                    if next == Some('\'') {
                        i += 1;
                    } else {
                        state = State::Code;
                    }
                }
            }
            State::Double => {
                if clickhouse && c == '\\' {
                    i += 1;
                } else if c == '"' {
                    if next == Some('"') {
                        i += 1;
                    } else {
                        state = State::Code;
                    }
                }
            }
            State::Backtick => {
                if clickhouse && (c == '\\' || (c == '`' && next == Some('`'))) {
                    i += 1;
                } else if c == '`' {
                    state = State::Code;
                }
            }
            State::LineComment => {
                if c == '\n' {
                    state = State::Code;
                }
            }
            State::BlockComment => {
                if c == '*' && next == Some('/') {
                    state = State::Code;
                    i += 1;
                }
            }
        }
        i += 1;
    }
    push(&mut out, start, chars.len(), has_code);
    out
}

/// The statement to run for a caret at `offset` (UTF-16): the one containing
/// it, else the nearest one before it (caret after `;` or on a blank line
/// below), else the next one.
pub fn statement_at(text: &str, offset: u32, driver: DbDriver) -> Option<SqlStatement> {
    let all = split(text, driver);
    if let Some(s) = all.iter().find(|s| s.from <= offset && offset <= s.to) {
        return Some(s.clone());
    }
    // Between statements: the previous one when only whitespace / `;` separates it from the caret.
    let prev = all.iter().rev().find(|s| s.to <= offset);
    let next = all.iter().find(|s| s.from > offset);
    match (prev, next) {
        (Some(p), Some(n)) => {
            let gap = utf16_slice(text, p.to, offset);
            let blank_lines = gap.matches('\n').count();
            if blank_lines <= 1 { Some(p.clone()) } else { Some(n.clone()) }
        }
        (Some(p), None) => Some(p.clone()),
        (None, n) => n.cloned(),
    }
}

/// Statements overlapping the UTF-16 range `from..to` (a selection): the
/// selected text itself, split.
pub fn statements_in(text: &str, from: u32, to: u32, driver: DbDriver) -> Vec<SqlStatement> {
    let selected = utf16_slice(text, from, to);
    split(selected, driver).into_iter().map(|s| SqlStatement { from: s.from + from, to: s.to + from, ..s }).collect()
}

fn utf16_slice(text: &str, from: u32, to: u32) -> &str {
    let mut u = 0u32;
    let (mut a, mut b) = (text.len(), text.len());
    for (i, c) in text.char_indices() {
        if u == from && a == text.len() {
            a = i;
        }
        if u == to {
            b = i;
            break;
        }
        u += c.len_utf16() as u32;
    }
    if a > b { "" } else { &text[a..b] }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(sql: &str, d: DbDriver) -> Vec<String> {
        split(sql, d).into_iter().map(|s| s.text).collect()
    }

    #[test]
    fn splits_on_semicolons_outside_literals_and_comments() {
        let sql = "select 'a;b' as x; -- c;d\nselect \"x;y\" from t /* ; */;\n\n-- only a comment;\n";
        assert_eq!(texts(sql, DbDriver::Sqlite), vec!["select 'a;b' as x", "-- c;d\nselect \"x;y\" from t /* ; */"]);
    }

    #[test]
    fn mysql_backticks_hashes_and_backslashes() {
        let sql = "select `a;b`, 'it\\'s;' from t # x;y\n; select 2";
        assert_eq!(texts(sql, DbDriver::Mysql), vec!["select `a;b`, 'it\\'s;' from t # x;y", "select 2"]);
    }

    #[test]
    fn clickhouse_backticks_and_escaped_quotes_keep_statements_intact() {
        let query = r#"SELECT `a\`;b`, "c\";d", 'it\'s;safe'; SELECT 2"#;
        assert_eq!(texts(query, DbDriver::Clickhouse), vec![r#"SELECT `a\`;b`, "c\";d", 'it\'s;safe'"#, "SELECT 2"]);
    }

    #[test]
    fn postgres_dollar_quotes() {
        let sql =
            "create function f() returns int as $$ select 1; $$ language sql; select $1::int; do $x$ begin; end $x$";
        assert_eq!(
            texts(sql, DbDriver::Postgres),
            vec![
                "create function f() returns int as $$ select 1; $$ language sql",
                "select $1::int",
                "do $x$ begin; end $x$"
            ]
        );
    }

    #[test]
    fn utf16_offsets() {
        let sql = "select '😀';\nselect 2;";
        let s = split(sql, DbDriver::Sqlite);
        assert_eq!((s[0].from, s[0].to), (0, 11));
        assert_eq!((s[1].from, s[1].to), (13, 21));
    }

    #[test]
    fn statement_at_caret() {
        let sql = "select 1;\nselect 2;\n\n\nselect 3";
        let at = |o| statement_at(sql, o, DbDriver::Sqlite).map(|s| s.text);
        assert_eq!(at(0).as_deref(), Some("select 1"));
        assert_eq!(at(9).as_deref(), Some("select 1"), "right after ;");
        assert_eq!(at(12).as_deref(), Some("select 2"));
        assert_eq!(at(20).as_deref(), Some("select 2"), "end of line after ;");
        assert_eq!(at(21).as_deref(), Some("select 3"), "after blank lines, the next one");
        assert_eq!(at(30).as_deref(), Some("select 3"));
        assert_eq!(statement_at("  ", 1, DbDriver::Sqlite), None);
    }

    #[test]
    fn selection() {
        let sql = "x; select 1; select 2; y";
        let s = statements_in(sql, 3, 21, DbDriver::Sqlite);
        assert_eq!(s.iter().map(|s| s.text.as_str()).collect::<Vec<_>>(), vec!["select 1", "select 2"]);
        assert_eq!((s[1].from, s[1].to), (13, 21));
    }
}
