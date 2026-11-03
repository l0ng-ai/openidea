//! The `iconThemes` extension point: file and folder icons.
//!
//! ```toml
//! [[contributes.iconThemes]]
//! id = "material"
//! label = "Material Icons"
//! path = "icons/theme.json"
//! ```
//!
//! `theme.json` (paths relative to the package):
//!
//! ```json
//! {
//!   "iconDefinitions": { "rust": "icons/rust.svg", "folder-src": "icons/folder-src.svg" },
//!   "file": "file", "folder": "folder", "folderExpanded": "folder-open",
//!   "fileExtensions": { "rs": "rust" },
//!   "fileNames": { "cargo.toml": "cargo" },
//!   "folderNames": { "src": "folder-src" }
//! }
//! ```
//!
//! Every SVG is sanitised here (allow-listed elements and attributes, no
//! scripts, event handlers, external references or entities) and stored as an
//! asset; the client fetches the mapping and the icons only when the theme is
//! selected, so installed icon themes cost nothing at start-up.

use ide_extension::{Package, UiDecl, check_relative, decode, validate_item_id};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

pub const POINT_ID: &str = "iconThemes";
const MAX_ICONS: usize = 5000;
const MAX_SVG: usize = 64 << 10;
const MAX_MAPPINGS: usize = 20_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decl {
    id: String,
    label: String,
    path: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThemeFile {
    icon_definitions: BTreeMap<String, PathBuf>,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    folder: Option<String>,
    #[serde(default)]
    folder_expanded: Option<String>,
    #[serde(default)]
    file_extensions: BTreeMap<String, String>,
    #[serde(default)]
    file_names: BTreeMap<String, String>,
    #[serde(default)]
    folder_names: BTreeMap<String, String>,
}

/// Asset id of a theme's mapping (JSON).
pub fn map_asset(theme: &str) -> String {
    format!("iconTheme/{theme}/map")
}

/// Asset id prefix of a theme's SVGs (`…/svg/<icon id>`).
pub fn svg_prefix(theme: &str) -> String {
    format!("iconTheme/{theme}/svg/")
}

/// An SVG icon of the package, size-checked and sanitised.
pub(super) fn read_icon(pkg: &Package, path: &std::path::Path) -> Result<String, String> {
    check_relative(path, "icon")?;
    let svg = pkg.read_text(path)?;
    if svg.len() > MAX_SVG {
        return Err(format!("{}: larger than {} KiB", path.display(), MAX_SVG >> 10));
    }
    sanitize_svg(&svg).map_err(|e| format!("{}: {e}", path.display()))
}

pub(super) fn icon_theme(pkg: &Package, decl: toml::Value) -> Result<UiDecl, String> {
    let d: Decl = decode(POINT_ID, decl)?;
    validate_item_id(&d.id, "icon theme id")?;
    if d.label.trim().is_empty() {
        return Err(format!("icon theme {:?} has an empty label", d.id));
    }
    let src = pkg.read_text(&d.path)?;
    let theme: ThemeFile = serde_json::from_str(&src).map_err(|e| format!("{}: {e}", d.path.display()))?;
    let at = |what: &str| format!("{} ({what})", d.path.display());
    if theme.icon_definitions.len() > MAX_ICONS {
        return Err(format!("{}: more than {MAX_ICONS} icons", d.path.display()));
    }
    let mappings = theme.file_extensions.len() + theme.file_names.len() + theme.folder_names.len();
    if mappings > MAX_MAPPINGS {
        return Err(format!("{}: more than {MAX_MAPPINGS} mappings", d.path.display()));
    }
    let defined: BTreeSet<&str> = theme.icon_definitions.keys().map(String::as_str).collect();
    let check_ref = |icon: &str, what: &str| -> Result<(), String> {
        if defined.contains(icon) { Ok(()) } else { Err(format!("{}: unknown icon {icon:?}", at(what))) }
    };
    for (what, icon) in [("file", &theme.file), ("folder", &theme.folder), ("folderExpanded", &theme.folder_expanded)] {
        if let Some(icon) = icon {
            check_ref(icon, what)?;
        }
    }
    // Extensions may be written with their dot (`.rs`); names keep theirs (`.github`, `.gitignore`).
    let lower = |map: &BTreeMap<String, String>, what: &str| -> Result<BTreeMap<String, String>, String> {
        let mut out = BTreeMap::new();
        for (k, icon) in map {
            check_ref(icon, what)?;
            let key = k.trim();
            let key = if what == "fileExtensions" { key.trim_start_matches('.') } else { key }.to_lowercase();
            if key.is_empty() || key.contains(['/', '\\']) {
                return Err(format!("{}: invalid key {k:?}", at(what)));
            }
            out.insert(key, icon.clone());
        }
        Ok(out)
    };
    let file_extensions = lower(&theme.file_extensions, "fileExtensions")?;
    let file_names = lower(&theme.file_names, "fileNames")?;
    let folder_names = lower(&theme.folder_names, "folderNames")?;

    let mut assets = Vec::with_capacity(theme.icon_definitions.len() + 1);
    let mut files = vec![d.path.clone()];
    for (icon, path) in &theme.icon_definitions {
        validate_item_id(icon, "icon id")?;
        let clean = read_icon(pkg, path)?;
        assets.push((format!("{}{icon}", svg_prefix(&d.id)), clean));
        files.push(path.clone());
    }
    let map = serde_json::json!({
        "file": theme.file,
        "folder": theme.folder,
        "folderExpanded": theme.folder_expanded,
        "fileExtensions": file_extensions,
        "fileNames": file_names,
        "folderNames": folder_names,
    });
    assets.push((map_asset(&d.id), map.to_string()));
    let json = serde_json::json!({ "id": d.id, "label": d.label, "icons": theme.icon_definitions.len() });
    let mut out = UiDecl::new(d.id.clone(), d.label, json);
    out.files = files;
    out.assets = assets;
    Ok(out)
}

// ---------------------------------------------------------------------------
// SVG sanitiser

const ELEMENTS: &[&str] = &[
    "svg",
    "g",
    "path",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "rect",
    "defs",
    "lineargradient",
    "radialgradient",
    "stop",
    "clippath",
    "mask",
    "use",
    "symbol",
    "pattern",
    "text",
    "tspan",
    "filter",
    "fegaussianblur",
    "feoffset",
    "feblend",
    "fecolormatrix",
    "feflood",
    "fecomposite",
    "femerge",
    "femergenode",
    "fedropshadow",
];

/// Dropped with their content: harmless metadata.
const STRIPPED: &[&str] = &["title", "desc", "metadata"];

const ATTRIBUTES: &[&str] = &[
    "id",
    "class",
    "viewbox",
    "width",
    "height",
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "fx",
    "fy",
    "d",
    "points",
    "transform",
    "fill",
    "fill-opacity",
    "fill-rule",
    "clip-rule",
    "clip-path",
    "mask",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-opacity",
    "opacity",
    "offset",
    "stop-color",
    "stop-opacity",
    "gradientunits",
    "gradienttransform",
    "spreadmethod",
    "patternunits",
    "patterncontentunits",
    "patterntransform",
    "clippathunits",
    "maskunits",
    "maskcontentunits",
    "preserveaspectratio",
    "style",
    "href",
    "xlink:href",
    "xmlns",
    "xmlns:xlink",
    "version",
    "font-family",
    "font-size",
    "font-weight",
    "text-anchor",
    "dominant-baseline",
    "letter-spacing",
    "display",
    "visibility",
    "color",
    "filter",
    "in",
    "in2",
    "result",
    "stddeviation",
    "dx",
    "dy",
    "mode",
    "operator",
    "values",
    "type",
    "flood-color",
    "flood-opacity",
    "k1",
    "k2",
    "k3",
    "k4",
    "filterunits",
    "primitiveunits",
    "vector-effect",
    "shape-rendering",
    "isolation",
    "mix-blend-mode",
];

/// Parses `src` and re-serialises the allow-listed subset. Fails on anything
/// that could execute, fetch or escape (scripts, `foreignObject`, event
/// handlers, external `href`s, `url()` to anything but a local fragment,
/// DTDs, entities, CDATA).
pub fn sanitize_svg(src: &str) -> Result<String, String> {
    let mut out = String::with_capacity(src.len());
    let mut stack: Vec<String> = Vec::new();
    // Depth inside a stripped element (its content is skipped).
    let mut skip_depth = 0usize;
    let mut seen_root = false;
    let mut rest = src;
    while !rest.is_empty() {
        let Some(lt) = rest.find('<') else {
            if skip_depth == 0 && !stack.is_empty() {
                out.push_str(&text(rest)?);
            } else if !rest.trim().is_empty() && stack.is_empty() {
                return Err("text outside the <svg> element".into());
            }
            break;
        };
        if lt > 0 {
            let t = &rest[..lt];
            if skip_depth == 0 && !stack.is_empty() {
                out.push_str(&text(t)?);
            } else if stack.is_empty() && !t.trim().is_empty() {
                return Err("text outside the <svg> element".into());
            }
        }
        rest = &rest[lt..];
        if let Some(after) = rest.strip_prefix("<!--") {
            let end = after.find("-->").ok_or("unterminated comment")?;
            rest = &after[end + 3..];
            continue;
        }
        if rest.starts_with("<?") {
            let end = rest.find("?>").ok_or("unterminated processing instruction")?;
            rest = &rest[end + 2..];
            continue;
        }
        if rest.starts_with("<!") {
            return Err("DTDs, entities and CDATA are not allowed".into());
        }
        if let Some(after) = rest.strip_prefix("</") {
            let end = after.find('>').ok_or("unterminated closing tag")?;
            let name = after[..end].trim().to_ascii_lowercase();
            rest = &after[end + 1..];
            let open = stack.pop().ok_or_else(|| format!("unexpected </{name}>"))?;
            if open != name {
                return Err(format!("</{name}> does not close <{open}>"));
            }
            if skip_depth > 0 {
                skip_depth -= 1;
            } else {
                out.push_str(&format!("</{name}>"));
            }
            continue;
        }
        // Start tag.
        let end = tag_end(rest).ok_or("unterminated tag")?;
        let inner = &rest[1..end];
        rest = &rest[end + 1..];
        let self_closing = inner.trim_end().ends_with('/');
        let inner = inner.trim_end().trim_end_matches('/');
        let name_end = inner.find(|c: char| c.is_whitespace()).unwrap_or(inner.len());
        let raw_name = &inner[..name_end];
        let name = raw_name.to_ascii_lowercase();
        if name.is_empty() {
            return Err("empty tag".into());
        }
        if stack.is_empty() {
            if seen_root || name != "svg" {
                return Err("the file must contain exactly one <svg> element".into());
            }
            seen_root = true;
        }
        if !self_closing {
            stack.push(name.clone());
        }
        if skip_depth > 0 {
            if !self_closing {
                skip_depth += 1;
            }
            continue;
        }
        if STRIPPED.contains(&name.as_str()) || name.contains(':') {
            // Editor metadata (sodipodi:namedview) or descriptive text.
            if !self_closing {
                skip_depth = 1;
            }
            continue;
        }
        if !ELEMENTS.contains(&name.as_str()) {
            return Err(format!("<{raw_name}> is not allowed"));
        }
        out.push('<');
        out.push_str(raw_name);
        for (attr, value) in attributes(&inner[name_end..])? {
            let key = attr.to_ascii_lowercase();
            if key.starts_with("on") {
                return Err(format!("event handler {attr} is not allowed"));
            }
            if key.contains(':') && !matches!(key.as_str(), "xlink:href" | "xmlns:xlink") {
                continue; // inkscape:label, sodipodi:docname, …
            }
            if !ATTRIBUTES.contains(&key.as_str()) && !key.starts_with("data-") && !key.starts_with("aria-") {
                return Err(format!("attribute {attr} is not allowed"));
            }
            check_value(&key, &value).map_err(|e| format!("{attr}: {e}"))?;
            out.push(' ');
            out.push_str(&attr);
            out.push_str("=\"");
            out.push_str(&escape(&value));
            out.push('"');
        }
        out.push_str(if self_closing { "/>" } else { ">" });
    }
    if !stack.is_empty() {
        return Err(format!("<{}> is not closed", stack.last().map(String::as_str).unwrap_or("?")));
    }
    if !seen_root {
        return Err("no <svg> element".into());
    }
    Ok(out)
}

/// Index of the `>` ending the tag at the start of `s`, skipping quoted values.
fn tag_end(s: &str) -> Option<usize> {
    let mut quote: Option<char> = None;
    for (i, c) in s.char_indices().skip(1) {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '>') => return Some(i),
            (None, '<') => return None,
            _ => {}
        }
    }
    None
}

fn attributes(s: &str) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    let mut rest = s.trim_start();
    while !rest.is_empty() {
        let eq = rest.find('=').ok_or_else(|| format!("attribute without value near {:?}", clip(rest)))?;
        let name = rest[..eq].trim();
        if name.is_empty() || name.contains(|c: char| c.is_whitespace() || c == '"' || c == '\'') {
            return Err(format!("malformed attribute near {:?}", clip(rest)));
        }
        let after = rest[eq + 1..].trim_start();
        let quote = after.chars().next().filter(|c| *c == '"' || *c == '\'').ok_or("unquoted attribute value")?;
        let close = after[1..].find(quote).ok_or("unterminated attribute value")?;
        let value = decode_entities(&after[1..1 + close])?;
        if out.iter().any(|(n, _): &(String, String)| n.eq_ignore_ascii_case(name)) {
            return Err(format!("duplicate attribute {name}"));
        }
        out.push((name.to_owned(), value));
        rest = after[close + 2..].trim_start();
    }
    Ok(out)
}

fn check_value(key: &str, value: &str) -> Result<(), String> {
    let lower = value.to_ascii_lowercase();
    if matches!(key, "href" | "xlink:href") {
        return if value.starts_with('#') { Ok(()) } else { Err("only local references (#id) are allowed".into()) };
    }
    if key == "xmlns" || key == "xmlns:xlink" {
        return Ok(());
    }
    if lower.contains("javascript:")
        || lower.contains("expression(")
        || lower.contains("@import")
        || value.contains('\\')
    {
        return Err("unsafe value".into());
    }
    let mut rest = lower.as_str();
    while let Some(i) = rest.find("url(") {
        let inner = rest[i + 4..].trim_start().trim_start_matches(['"', '\'']);
        if !inner.starts_with('#') {
            return Err("url() may only reference a local fragment".into());
        }
        rest = &rest[i + 4..];
    }
    Ok(())
}

fn decode_entities(s: &str) -> Result<String, String> {
    if !s.contains('&') {
        return Ok(s.to_owned());
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let semi = rest[i..].find(';').ok_or("unterminated entity")?;
        let ent = &rest[i + 1..i + semi];
        let c = match ent {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            _ => {
                let code = if let Some(hex) = ent.strip_prefix("#x").or_else(|| ent.strip_prefix("#X")) {
                    u32::from_str_radix(hex, 16).ok()
                } else if let Some(dec) = ent.strip_prefix('#') {
                    dec.parse().ok()
                } else {
                    None
                };
                code.and_then(char::from_u32).ok_or_else(|| format!("entity &{ent}; is not allowed"))?
            }
        };
        out.push(c);
        rest = &rest[i + semi + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn text(t: &str) -> Result<String, String> {
    Ok(escape(&decode_entities(t)?))
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn clip(s: &str) -> &str {
    let mut end = s.len().min(24);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_ordinary_icons() {
        let src = r##"<?xml version="1.0"?>
<!-- Material icon -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="x" viewBox="0 0 24 24" inkscape:version="1">
  <title>rust</title>
  <defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>
  <path fill="url(#g)" d="M1 2h3 &amp; 4" style="opacity:.5"/>
  <use href="#g"/>
</svg>"##;
        let out = sanitize_svg(src).unwrap();
        assert!(out.starts_with("<svg xmlns="), "{out}");
        assert!(!out.contains("title") && !out.contains("inkscape") && !out.contains("<!--"));
        assert!(out.contains(r#"fill="url(#g)""#));
        assert!(out.contains(r#"d="M1 2h3 &amp; 4""#));
        assert!(out.ends_with("</svg>"));
    }

    #[test]
    fn rejects_active_content() {
        let bad = [
            r##"<svg><script>alert(1)</script></svg>"##,
            r##"<svg onload="alert(1)"></svg>"##,
            r##"<svg><foreignObject/></svg>"##,
            r##"<svg><use href="https://evil/x.svg#a"/></svg>"##,
            r##"<svg><use xlink:href="data:image/svg+xml,..."/></svg>"##,
            r##"<svg><rect style="fill:url(https://evil)"/></svg>"##,
            r##"<svg><rect fill="url( 'http://x' )"/></svg>"##,
            r##"<!DOCTYPE svg [<!ENTITY x "y">]><svg/>"##,
            r##"<svg><![CDATA[x]]></svg>"##,
            r##"<svg><a href="#x"/></svg>"##,
            r##"<svg><rect width="&xx;"/></svg>"##,
            r##"<svg><rect width=10/></svg>"##,
            r##"<svg><g></svg>"##,
            r##"<svg/><svg/>"##,
            r##"<g/>"##,
            r##"hello"##,
            r##"<svg><rect style="behavior:url(#x);x:expression(1)"/></svg>"##,
        ];
        for src in bad {
            assert!(sanitize_svg(src).is_err(), "accepted: {src}");
        }
    }

    #[test]
    fn theme_files_validate_and_produce_assets() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::create_dir_all(dir.join("icons")).unwrap();
        std::fs::write(dir.join("icons/rust.svg"), r#"<svg viewBox="0 0 16 16"><path d="M0 0h16v16z"/></svg>"#)
            .unwrap();
        std::fs::write(dir.join("icons/file.svg"), r#"<svg viewBox="0 0 16 16"><rect width="16" height="16"/></svg>"#)
            .unwrap();
        std::fs::write(
            dir.join("theme.json"),
            r#"{"iconDefinitions":{"rust":"icons/rust.svg","file":"icons/file.svg"},"file":"file",
                "fileExtensions":{".RS":"rust"},"fileNames":{"Cargo.toml":"rust",".gitignore":"file"},
                "folderNames":{".GitHub":"file","src":"rust"}}"#,
        )
        .unwrap();
        let manifest = ide_extension::Manifest::parse(
            "id = \"p\"\nname = \"P\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"",
        )
        .unwrap();
        let pkg = Package::new(manifest, dir.to_path_buf());
        let decl = |path: &str| {
            let mut t = toml::Table::new();
            t.insert("id".into(), "m".into());
            t.insert("label".into(), "M".into());
            t.insert("path".into(), path.into());
            toml::Value::Table(t)
        };
        let d = icon_theme(&pkg, decl("theme.json")).unwrap();
        assert_eq!(d.json["icons"], 2);
        assert_eq!(d.files.len(), 3);
        let map: serde_json::Value =
            serde_json::from_str(&d.assets.iter().find(|(k, _)| *k == map_asset("m")).unwrap().1).unwrap();
        assert_eq!(map["fileExtensions"]["rs"], "rust");
        assert_eq!(map["fileNames"]["cargo.toml"], "rust");
        // Names keep their leading dot (only extensions drop it).
        assert_eq!(map["fileNames"][".gitignore"], "file");
        assert_eq!(map["folderNames"][".github"], "file");
        assert_eq!(map["folderNames"]["src"], "rust");
        assert!(map["folderNames"].get("github").is_none());
        assert!(d.assets.iter().any(|(k, _)| *k == format!("{}rust", svg_prefix("m"))));

        std::fs::write(dir.join("bad.json"), r#"{"iconDefinitions":{},"fileExtensions":{"rs":"nope"}}"#).unwrap();
        assert!(icon_theme(&pkg, decl("bad.json")).unwrap_err().contains("unknown icon"));
        std::fs::write(dir.join("icons/evil.svg"), r#"<svg><script/></svg>"#).unwrap();
        std::fs::write(dir.join("evil.json"), r#"{"iconDefinitions":{"e":"icons/evil.svg"}}"#).unwrap();
        assert!(icon_theme(&pkg, decl("evil.json")).unwrap_err().contains("evil.svg"));
        assert!(icon_theme(&pkg, decl("../x.json")).is_err());
    }
}
