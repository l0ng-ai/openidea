use ide_lsp::types::{Hover, Markup};
use ide_plugin::PluginHover;

pub(crate) fn merge(server: Option<Hover>, plugin: Vec<PluginHover>) -> Option<Hover> {
    if plugin.is_empty() {
        return server;
    }
    let mut parts = Vec::with_capacity(plugin.len() + 1);
    let mut range = None;
    if let Some(h) = server {
        range = h.range;
        if !h.contents.value.trim().is_empty() {
            parts.push(if h.contents.kind == "markdown" { h.contents.value } else { escape(&h.contents.value) });
        }
    }
    for h in plugin {
        range = range.or(h.range);
        parts.push(h.markdown);
    }
    Some(Hover { contents: Markup { kind: "markdown".into(), value: parts.join("\n\n---\n\n") }, range })
}

fn escape(plain: &str) -> String {
    let mut out = String::with_capacity(plain.len() + plain.len() / 4);
    for c in plain.chars() {
        match c {
            '\n' => out.push_str("  \n"),
            '\\' | '`' | '*' | '_' | '{' | '}' | '[' | ']' | '<' | '>' | '(' | ')' | '#' | '+' | '-' | '.' | '!'
            | '|' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::{Pos, Range};

    fn range(line: u32, from: u32, to: u32) -> Range {
        Range::new(Pos::new(line, from), Pos::new(line, to))
    }

    fn plugin(markdown: &str, at: Option<Range>) -> PluginHover {
        PluginHover { markdown: markdown.into(), range: at }
    }

    fn server(kind: &str, value: &str, at: Option<Range>) -> Hover {
        Hover { contents: Markup { kind: kind.into(), value: value.into() }, range: at }
    }

    #[test]
    fn plugin_content_follows_the_server_hover() {
        let merged = merge(
            Some(server("markdown", "```php\nfunction route()\n```", Some(range(3, 4, 9)))),
            vec![plugin("**orders.index** · `GET /orders`", Some(range(3, 10, 22)))],
        )
        .unwrap();
        assert_eq!(merged.contents.kind, "markdown");
        assert_eq!(merged.contents.value, "```php\nfunction route()\n```\n\n---\n\n**orders.index** · `GET /orders`");
        assert_eq!(merged.range, Some(range(3, 4, 9)));
    }

    #[test]
    fn without_a_server_hover_the_plugins_answer_alone() {
        let merged = merge(None, vec![plugin("one", None), plugin("two", Some(range(1, 0, 3)))]).unwrap();
        assert_eq!(merged.contents.value, "one\n\n---\n\ntwo");
        assert_eq!(merged.range, Some(range(1, 0, 3)));
        assert!(merge(None, Vec::new()).is_none());
    }

    #[test]
    fn plain_text_from_the_server_keeps_its_characters() {
        let merged = merge(Some(server("plaintext", "a_b *c*\nd", None)), vec![plugin("x", None)]).unwrap();
        assert_eq!(merged.contents.value, "a\\_b \\*c\\*  \nd\n\n---\n\nx");
    }

    #[test]
    fn an_empty_server_hover_is_left_out() {
        let merged = merge(Some(server("markdown", "  ", None)), vec![plugin("x", None)]).unwrap();
        assert_eq!(merged.contents.value, "x");
    }

    #[test]
    fn no_plugin_content_keeps_the_server_hover() {
        let kept = merge(Some(server("plaintext", "a_b", Some(range(0, 0, 1)))), Vec::new()).unwrap();
        assert_eq!((kept.contents.kind.as_str(), kept.contents.value.as_str()), ("plaintext", "a_b"));
        assert_eq!(kept.range, Some(range(0, 0, 1)));
    }
}
