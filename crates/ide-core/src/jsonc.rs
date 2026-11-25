//! JSON with comments (`devcontainer.json`, `deno.jsonc`, `tsconfig.json`): turned
//! into plain JSON for `serde_json`.

/// Strips `//` and `/* */` comments, trailing commas and a leading byte order mark (Visual
/// Studio writes one into `launchSettings.json`) so JSONC parses as JSON.
pub fn strip(src: &str) -> String {
    let src = src.strip_prefix('\u{feff}').unwrap_or(src);
    let mut out = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
    let mut in_str = false;
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                out.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = '\0';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    // Keep the comment's line breaks so parse errors report the original line.
                    if n == '\n' {
                        out.push('\n');
                    }
                    prev = n;
                }
            }
            _ => out.push(c),
        }
    }
    // Remove trailing commas before `}` / `]` (outside strings).
    let mut cleaned = String::with_capacity(out.len());
    let bytes: Vec<char> = out.chars().collect();
    let mut in_str = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            cleaned.push(c);
            if c == '\\' && i + 1 < bytes.len() {
                cleaned.push(bytes[i + 1]);
                i += 1;
            } else if c == '"' {
                in_str = false;
            }
        } else if c == '"' {
            in_str = true;
            cleaned.push(c);
        } else if c == ',' {
            let next = bytes[i + 1..].iter().find(|ch| !ch.is_ascii_whitespace());
            if !matches!(next, Some('}') | Some(']')) {
                cleaned.push(c);
            }
        } else {
            cleaned.push(c);
        }
        i += 1;
    }
    cleaned
}

#[cfg(test)]
mod tests {
    use super::strip;

    #[test]
    fn drops_comments_and_trailing_commas_outside_strings() {
        let src = "{\n  // line\n  \"a\": [1, 2,], /* block */\n  \"url\": \"https://x.dev//y /* no */\",\n  \"q\": \"say \\\"hi\\\",\",\n}\n";
        let v: serde_json::Value = serde_json::from_str(&strip(src)).unwrap();
        assert_eq!(v["a"], serde_json::json!([1, 2]));
        assert_eq!(v["url"], "https://x.dev//y /* no */");
        assert_eq!(v["q"], "say \"hi\",");
    }

    #[test]
    fn drops_a_byte_order_mark() {
        let v: serde_json::Value = serde_json::from_str(&strip("\u{feff}{ \"a\": 1 }")).unwrap();
        assert_eq!(v["a"], 1);
    }

    #[test]
    fn keeps_line_breaks_of_block_comments_so_errors_report_the_original_line() {
        assert_eq!(strip("{\"a\"/*\n\n*/:x}"), "{\"a\"\n\n:x}");
        let err = serde_json::from_str::<serde_json::Value>(&strip("{\"a\"/*\n\n*/:x}")).unwrap_err();
        assert_eq!(err.line(), 3);
        // A comment is whitespace, not a join: `1 2` stays invalid.
        assert!(serde_json::from_str::<serde_json::Value>(&strip("1/*\n*/2")).is_err());
    }

    #[test]
    fn line_comments_keep_their_line_break_and_may_end_the_input() {
        assert_eq!(strip("{\"a\":1} // tail"), "{\"a\":1} ");
        assert_eq!(strip("// a\r\n{\"a\":1}"), "\n{\"a\":1}");
        assert_eq!(strip("[1, // c\n2]"), "[1, \n2]");
    }

    #[test]
    fn unterminated_block_comment_drops_the_rest() {
        assert_eq!(strip("{\"a\":1}/* open"), "{\"a\":1}");
        assert_eq!(strip("/*"), "");
        assert_eq!(strip("/*/ x"), "");
        assert_eq!(strip("/**/{}"), "{}");
        assert_eq!(strip("/***/{}"), "{}");
    }

    #[test]
    fn comment_markers_inside_strings_survive_including_after_escapes() {
        let src = "{\"a\":\"\\\\\",\"b\":\"//x\",\"c\":\"/*y*/\",\"d\":\"é,\u{1F600}\"} // é";
        let v: serde_json::Value = serde_json::from_str(&strip(src)).unwrap();
        assert_eq!(v, serde_json::json!({"a": "\\", "b": "//x", "c": "/*y*/", "d": "é,\u{1F600}"}));
    }

    #[test]
    fn trailing_commas_are_dropped_across_whitespace_and_comments_only_before_a_closer() {
        assert_eq!(strip("[1,2, ]"), "[1,2 ]");
        assert_eq!(strip("[1,\r\n]"), "[1\r\n]");
        assert_eq!(strip("[1,/*c*/]"), "[1]");
        assert_eq!(strip("[1,//c\n]"), "[1\n]");
        assert_eq!(strip("[1,/*c*/ ,]"), "[1, ]");
        assert_eq!(strip("{\"a\":\"x,}\"}"), "{\"a\":\"x,}\"}");
        assert_eq!(strip("[1,2]"), "[1,2]");
    }

    #[test]
    fn only_json_whitespace_may_separate_a_trailing_comma_from_its_closer() {
        // U+00A0 is not JSON whitespace: the comma stays and serde_json reports it.
        assert_eq!(strip("[1,\u{a0}]"), "[1,\u{a0}]");
    }
}
