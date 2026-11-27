//! Go workspace module paths shared by project builds and run detection.
use std::path::PathBuf;

/// Module directories from a go.work file. Quoted paths and comments follow Go's file syntax.
pub fn work_modules(text: &str) -> Vec<PathBuf> {
    let mut tokens = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\n' | '(' | ')' => tokens.push(ch.to_string()),
            ch if ch.is_whitespace() => {}
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        tokens.push("\n".into());
                        break;
                    }
                }
            }
            '"' | '`' => {
                let Some(token) = quoted_work_path(&mut chars, ch) else { return Vec::new() };
                tokens.push(token);
            }
            _ => {
                let mut token = ch.to_string();
                while chars.peek().is_some_and(|c| !c.is_whitespace() && *c != '(' && *c != ')') {
                    token.push(chars.next().unwrap());
                }
                tokens.push(token);
            }
        }
    }
    let mut out = Vec::new();
    let mut start = true;
    let mut tokens = tokens.into_iter();
    while let Some(token) = tokens.next() {
        if token == "\n" {
            start = true;
            continue;
        }
        if start
            && token == "use"
            && let Some(path) = tokens.next()
        {
            if path == "(" {
                let mut paths = Vec::new();
                let mut closed = false;
                for path in tokens.by_ref() {
                    if path == ")" {
                        closed = true;
                        break;
                    }
                    if path != "\n" && !path.is_empty() {
                        paths.push(PathBuf::from(path));
                    }
                }
                if closed {
                    out.extend(paths);
                }
            } else if path != "\n" && !path.is_empty() {
                out.push(PathBuf::from(path));
            }
        }
        start = false;
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|path| seen.insert(path.clone()));
    out
}

fn quoted_work_path(chars: &mut std::iter::Peekable<std::str::Chars<'_>>, quote: char) -> Option<String> {
    let mut bytes = Vec::new();
    while let Some(ch) = chars.next() {
        if ch == quote {
            return String::from_utf8(bytes).ok();
        }
        if ch == '\\' && quote == '"' {
            let escaped = chars.next()?;
            let byte = match escaped {
                'a' => 7,
                'b' => 8,
                'f' => 12,
                'n' => 10,
                'r' => 13,
                't' => 9,
                'v' => 11,
                '\\' => b'\\',
                '"' => b'"',
                'x' => {
                    let digits: String = chars.by_ref().take(2).collect();
                    if digits.len() != 2 {
                        return None;
                    }
                    u8::from_str_radix(&digits, 16).ok()?
                }
                'u' | 'U' => {
                    let width = if escaped == 'u' { 4 } else { 8 };
                    let digits: String = chars.by_ref().take(width).collect();
                    if digits.len() != width {
                        return None;
                    }
                    let ch = char::from_u32(u32::from_str_radix(&digits, 16).ok()?)?;
                    bytes.extend_from_slice(ch.to_string().as_bytes());
                    continue;
                }
                '0'..='7' => {
                    let digits = format!("{escaped}{}", chars.by_ref().take(2).collect::<String>());
                    if digits.len() != 3 {
                        return None;
                    }
                    u8::from_str_radix(&digits, 8).ok()?
                }
                _ => return None,
            };
            bytes.push(byte);
        } else {
            if ch == '\n' && quote == '"' {
                return None;
            }
            bytes.extend_from_slice(ch.to_string().as_bytes());
        }
    }
    None
}
