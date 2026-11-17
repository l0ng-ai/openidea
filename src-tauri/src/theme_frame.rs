//! Built-in themes' window frame colour (`--bg-frame`), read from the UI's own
//! `src/styles/tokens.css` so a native window opens in the colour its page paints.

use std::collections::HashMap;
use std::sync::LazyLock;
use tauri::utils::config::Color;

const TOKENS_CSS: &str = include_str!("../../src/styles/tokens.css");

/// A top-level rule: its selector list and custom-property declarations.
type Block = (Vec<String>, HashMap<String, String>);

/// The rule blocks of tokens.css, in source order.
static BLOCKS: LazyLock<Vec<Block>> = LazyLock::new(|| blocks(TOKENS_CSS));

/// `--bg-frame` of built-in theme `id` (`light`, `dark`, `dark-hc` or a palette
/// theme with a `:root[data-color-theme="<id>"]` block); `None` for any other id.
pub fn builtin_frame(id: &str) -> Option<Color> {
    builtin_frame_in(&BLOCKS, id)
}

fn builtin_frame_in(blocks: &[Block], id: &str) -> Option<Color> {
    let palette = format!(":root[data-color-theme=\"{id}\"]");
    let mut selectors = vec![":root".to_owned()];
    match id {
        "dark" => {}
        "light" => selectors.push(":root[data-theme=\"light\"]".into()),
        "dark-hc" => selectors.push(":root[data-theme=\"dark-hc\"]".into()),
        _ if blocks.iter().any(|(sel, _)| sel.contains(&palette)) => {
            if id.ends_with("light") {
                selectors.push(":root[data-theme=\"light\"]".into());
            }
            selectors.push(":root[data-color-theme]".into());
            selectors.push(palette);
        }
        _ => return None,
    }
    // Later matching blocks win, as in the page (the selectors involved share a specificity order).
    let mut vars: HashMap<&str, &str> = HashMap::new();
    for (sel, decls) in blocks {
        if sel.iter().any(|s| selectors.contains(s)) {
            vars.extend(decls.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        }
    }
    let mut value = *vars.get("--bg-frame")?;
    for _ in 0..8 {
        match value.strip_prefix("var(").and_then(|v| v.strip_suffix(')')) {
            Some(name) => value = vars.get(name.split(',').next()?.trim())?,
            None => return parse_color(value),
        }
    }
    None
}

fn blocks(css: &str) -> Vec<Block> {
    let mut text = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(start) = rest.find("/*") {
        text.push_str(&rest[..start]);
        rest = rest[start + 2..].find("*/").map_or("", |end| &rest[start + 2 + end + 2..]);
    }
    text.push_str(rest);

    let mut out = Vec::new();
    let mut rest = text.as_str();
    while let Some(open) = rest.find('{') {
        let selector = rest[..open].trim();
        // Matching close brace (nested at-rule blocks are skipped whole).
        let mut depth = 0;
        let Some(close) = rest[open..].char_indices().find_map(|(i, c)| {
            match c {
                '{' => depth += 1,
                '}' => depth -= 1,
                _ => {}
            }
            (depth == 0).then_some(open + i)
        }) else {
            break;
        };
        if !selector.starts_with('@') {
            let decls = rest[open + 1..close]
                .split(';')
                .filter_map(|d| d.split_once(':'))
                .filter(|(k, _)| k.trim().starts_with("--"))
                .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
                .collect();
            out.push((selector.split(',').map(|s| s.trim().to_owned()).collect(), decls));
        }
        rest = &rest[close + 1..];
    }
    out
}

/// `#hex` or `hsl(h, s%, l%)`, rounded to 8-bit channels as browsers do.
fn parse_color(value: &str) -> Option<Color> {
    if value.starts_with('#') {
        return serde_json::from_value(serde_json::Value::String(value.to_owned())).ok();
    }
    let args = value.strip_prefix("hsl(")?.strip_suffix(')')?;
    let nums: Vec<f64> = args
        .split([',', ' '])
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches("deg").trim_end_matches('%').parse())
        .collect::<Result<_, _>>()
        .ok()?;
    let [h, s, l] = nums[..] else { return None };
    let (s, l) = (s / 100.0, l / 100.0);
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = (h.rem_euclid(360.0)) / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r, g, b) = match hp as u8 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    let byte = |v: f64| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    Some(Color(byte(r), byte(g), byte(b), 0xff))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_builtin_frame_from_tokens_css() {
        for (id, color) in [
            ("light", Color(0xe9, 0xea, 0xee, 0xff)),
            ("dark", Color(0x26, 0x28, 0x2c, 0xff)),
            ("dark-hc", Color(0x1a, 0x1b, 0x1e, 0xff)),
            ("solarized-light", Color(0xee, 0xe8, 0xd5, 0xff)),
            ("solarized-dark", Color(0x07, 0x36, 0x42, 0xff)),
        ] {
            assert_eq!(builtin_frame(id), Some(color), "{id}");
        }
        assert_eq!(builtin_frame("system"), None);
        assert_eq!(builtin_frame("nope"), None);
    }

    #[test]
    fn resolves_var_chains_and_hsl() {
        let css = r#"
            /* a { comment } */
            :root { --bg-frame: #000; --p: hsl(0, 100%, 50%); }
            @media (x) { :root { --bg-frame: #fff; } }
            :root[data-color-theme] { --bg-frame: var(--q); }
            :root[data-color-theme="t-dark"] { --q: var(--p, #123); }
        "#;
        let b = blocks(css);
        assert_eq!(builtin_frame_in(&b, "dark"), Some(Color(0, 0, 0, 0xff)));
        assert_eq!(builtin_frame_in(&b, "t-dark"), Some(Color(0xff, 0, 0, 0xff)));
        assert_eq!(builtin_frame_in(&b, "u-dark"), None);
    }
}
