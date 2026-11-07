use std::collections::HashMap;
use std::str::Chars;

fn is_blank(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\x0c')
}

/// Parses the `java.util.Properties.store` text format. A malformed `\u` escape is read like
/// any other unknown escape, its characters kept without the backslash, rather than rejected:
/// the JVM, not the user, produced this text.
pub fn parse_properties(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut lines = text.lines();
    while let Some(first) = lines.next() {
        let first = first.trim_start_matches(is_blank);
        if first.is_empty() || first.starts_with('#') || first.starts_with('!') {
            continue;
        }
        let mut logical = String::new();
        let mut current = first;
        loop {
            // An odd number of trailing backslashes continues the entry on the next line.
            let slashes = current.bytes().rev().take_while(|b| *b == b'\\').count();
            if slashes % 2 == 0 {
                logical.push_str(current);
                break;
            }
            logical.push_str(&current[..current.len() - 1]);
            match lines.next() {
                Some(next) => current = next.trim_start_matches(is_blank),
                None => break,
            }
        }
        let (key, value) = split_entry(&logical);
        map.insert(unescape(key), unescape(value));
    }
    map
}

/// The value of `sun.jdwp.listenerAddress` is `<transport or host>:<port>`; the port follows the last colon.
pub fn jdwp_port(props: &HashMap<String, String>) -> Option<u16> {
    let address = props.get("sun.jdwp.listenerAddress")?;
    let (_, port) = address.rsplit_once(':')?;
    port.trim().parse::<u16>().ok().filter(|port| *port != 0)
}

fn split_entry(line: &str) -> (&str, &str) {
    let mut escaped = false;
    let mut key_end = line.len();
    for (i, c) in line.char_indices() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '=' || c == ':' || is_blank(c) {
            key_end = i;
            break;
        }
    }
    let mut rest = line[key_end..].trim_start_matches(is_blank);
    if let Some(stripped) = rest.strip_prefix(['=', ':']) {
        rest = stripped.trim_start_matches(is_blank);
    }
    (&line[..key_end], rest)
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('t') => out.push('\t'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('f') => out.push('\x0c'),
            Some('u') => push_unicode_escape(&mut chars, &mut out),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

fn hex4(chars: &mut Chars) -> Option<u16> {
    let mut value = 0u16;
    for _ in 0..4 {
        value = value * 16 + chars.next()?.to_digit(16)? as u16;
    }
    Some(value)
}

/// `store` writes supplementary characters as two `\uXXXX` surrogate escapes.
fn push_unicode_escape(chars: &mut Chars, out: &mut String) {
    // Parsed on a copy, so the digits of a malformed escape are still read as text.
    let mut digits = chars.clone();
    let Some(unit) = hex4(&mut digits) else {
        out.push('u');
        return;
    };
    *chars = digits;
    let mut units = vec![unit];
    if (0xD800..0xDC00).contains(&unit) {
        let mut ahead = chars.clone();
        if ahead.next() == Some('\\')
            && ahead.next() == Some('u')
            && let Some(low) = hex4(&mut ahead)
            && (0xDC00..0xE000).contains(&low)
        {
            units.push(low);
            *chars = ahead;
        }
    }
    out.extend(char::decode_utf16(units).map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_store_format_with_escapes() {
        let props = parse_properties("#c\nsun.jdwp.listenerAddress=dt_socket\\:64390\nk\\=x=a\\\\b\nu=\\u0041");
        assert_eq!(props["sun.jdwp.listenerAddress"], "dt_socket:64390");
        assert_eq!(props["k=x"], "a\\b");
        assert_eq!(props["u"], "A");
        assert_eq!(props.len(), 3);
    }

    #[test]
    fn handles_whitespace_separators_continuations_and_surrogates() {
        let props = parse_properties("! bang\n  a  :  1\nb 2\nc=x\\\n   y\nd=\\ud83d\\ude00\ne=\\t\\n\\r\\f\nf=\n");
        assert_eq!(props["a"], "1");
        assert_eq!(props["b"], "2");
        assert_eq!(props["c"], "xy");
        assert_eq!(props["d"], "\u{1F600}");
        assert_eq!(props["e"], "\t\n\r\x0c");
        assert_eq!(props["f"], "");
    }

    #[test]
    fn malformed_unicode_escape_keeps_its_characters() {
        let props = parse_properties("a=\\u00zz\nb=\\u12\nc=x\\u");
        assert_eq!(props["a"], "u00zz");
        assert_eq!(props["b"], "u12");
        assert_eq!(props["c"], "xu");
    }

    #[test]
    fn jdwp_port_forms() {
        let with = |value: &str| HashMap::from([("sun.jdwp.listenerAddress".to_string(), value.to_string())]);
        assert_eq!(jdwp_port(&with("dt_socket:64390")), Some(64390));
        assert_eq!(jdwp_port(&with("127.0.0.1:5005")), Some(5005));
        assert_eq!(jdwp_port(&HashMap::new()), None);
        assert_eq!(jdwp_port(&with("dt_socket:abc")), None);
        assert_eq!(jdwp_port(&with(":0")), None);
        assert_eq!(jdwp_port(&with("dt_socket")), None);
        assert_eq!(jdwp_port(&with("dt_socket:70000")), None);
    }
}
