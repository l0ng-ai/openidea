//! `.editorconfig` support (<https://spec.editorconfig.org>).
//!
//! Files are looked up from the edited file's directory upwards until one
//! declares `root = true`. Sections of files closer to the edited file win,
//! and within a file later sections win. Parsed files are cached and
//! re-read when their modification time or size changes.

use globset::{GlobBuilder, GlobMatcher};
use ide_text::LineEnding;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

pub const FILE_NAME: &str = ".editorconfig";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IndentStyle {
    Space,
    Tab,
}

/// Effective EditorConfig properties of one file. `None` = not specified
/// (or `unset`), so the IDE setting applies.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EditorConfigProps {
    pub indent_style: Option<IndentStyle>,
    /// Columns per indentation level (`indent_size = tab` resolves to `tab_width`).
    pub indent_size: Option<u32>,
    pub tab_width: Option<u32>,
    pub end_of_line: Option<LineEnding>,
    /// `utf-8`, `utf-8-bom`, `utf-16le`, `utf-16be`, `latin1` or an encoding
    /// Settings › Editor › File Encodings lists (`iso-8859-15`, `windows-1252`, `gbk`, …).
    pub charset: Option<String>,
    pub trim_trailing_whitespace: Option<bool>,
    pub insert_final_newline: Option<bool>,
    pub max_line_length: Option<u32>,
}

impl EditorConfigProps {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// WHATWG encoding label and BOM flag for `charset`.
    pub fn encoding(&self) -> Option<(&'static str, bool)> {
        charset_encoding(self.charset.as_deref()?)
    }
}

/// WHATWG label and BOM flag of a lower-cased `charset` value: the five the spec
/// defines and the other encodings Settings › Editor › File Encodings lists.
fn charset_encoding(charset: &str) -> Option<(&'static str, bool)> {
    Some(match charset {
        "utf-8" => ("utf-8", false),
        "utf-8-bom" => ("utf-8", true),
        "utf-16le" => ("utf-16le", true),
        "utf-16be" => ("utf-16be", true),
        // WHATWG decodes ISO-8859-1 as windows-1252.
        "latin1" | "iso-8859-1" | "windows-1252" => ("windows-1252", false),
        "iso-8859-15" => ("iso-8859-15", false),
        "gbk" => ("gbk", false),
        "gb18030" => ("gb18030", false),
        "big5" => ("big5", false),
        "shift_jis" => ("shift_jis", false),
        "euc-kr" => ("euc-kr", false),
        "koi8-r" => ("koi8-r", false),
        _ => return None,
    })
}

/// Raw `key = value` pairs (keys lower-cased) in application order.
type Pairs = Vec<(String, String)>;

struct Section {
    matcher: Option<GlobMatcher>,
    pairs: Pairs,
}

struct ParsedFile {
    root: bool,
    sections: Vec<Section>,
}

/// Parses `.editorconfig` text. Section globs containing `/` are relative to
/// the directory of the file.
fn parse(text: &str) -> ParsedFile {
    let mut file = ParsedFile { root: false, sections: Vec::new() };
    let mut current: Option<Section> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') && line.len() >= 2 {
            if let Some(s) = current.take() {
                file.sections.push(s);
            }
            let glob = &line[1..line.len() - 1];
            current = Some(Section { matcher: compile_glob(glob), pairs: Vec::new() });
            continue;
        }
        let Some((key, value)) = line.split_once(['=', ':']) else { continue };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().to_owned();
        match &mut current {
            Some(section) => section.pairs.push((key, value)),
            None => {
                if key == "root" {
                    file.root = value.eq_ignore_ascii_case("true");
                }
            }
        }
    }
    if let Some(s) = current.take() {
        file.sections.push(s);
    }
    file
}

/// Expands `{n..m}` numeric ranges into `{n,n+1,...,m}` (globset has no ranges).
fn expand_ranges(glob: &str) -> String {
    let mut out = String::with_capacity(glob.len());
    let mut rest = glob;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            out.push_str(&rest[open..]);
            return out;
        };
        let inner = &after[..close];
        let range = inner.split_once("..").and_then(|(a, b)| Some((a.parse::<i64>().ok()?, b.parse::<i64>().ok()?)));
        match range {
            Some((a, b)) if (b - a).abs() <= 1000 => {
                let (lo, hi) = (a.min(b), a.max(b));
                let items: Vec<String> = (lo..=hi).map(|n| n.to_string()).collect();
                out.push('{');
                out.push_str(&items.join(","));
                out.push('}');
            }
            _ => {
                out.push('{');
                out.push_str(inner);
                out.push('}');
            }
        }
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    out
}

fn compile_glob(glob: &str) -> Option<GlobMatcher> {
    let glob = expand_ranges(glob.trim());
    // Without a `/` the pattern matches the file name at any depth.
    let pattern = if !glob.contains('/') {
        format!("**/{glob}")
    } else if let Some(stripped) = glob.strip_prefix('/') {
        stripped.to_owned()
    } else {
        // `a/b.txt` is anchored to the .editorconfig directory as well.
        glob.clone()
    };
    match GlobBuilder::new(&pattern).literal_separator(true).backslash_escape(true).build() {
        Ok(g) => Some(g.compile_matcher()),
        Err(e) => {
            tracing::debug!("editorconfig: invalid section [{glob}]: {e}");
            None
        }
    }
}

fn apply_pairs(acc: &mut HashMap<String, String>, pairs: &Pairs) {
    for (k, v) in pairs {
        acc.insert(k.clone(), v.clone());
    }
}

fn props_from(map: &HashMap<String, String>) -> EditorConfigProps {
    let get = |k: &str| map.get(k).map(|v| v.to_ascii_lowercase()).filter(|v| v != "unset");
    let num = |k: &str| get(k).and_then(|v| v.parse::<u32>().ok()).filter(|n| *n > 0 && *n <= 256);
    let flag = |k: &str| match get(k).as_deref() {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    };
    let indent_style = match get("indent_style").as_deref() {
        Some("space") => Some(IndentStyle::Space),
        Some("tab") => Some(IndentStyle::Tab),
        _ => None,
    };
    let mut tab_width = num("tab_width");
    let mut indent_size = match get("indent_size").as_deref() {
        Some("tab") => tab_width,
        _ => num("indent_size"),
    };
    // Spec defaults: tab_width follows a numeric indent_size; indent_size = tab
    // (or indent_style = tab without indent_size) follows tab_width.
    if tab_width.is_none() && get("indent_size").as_deref() != Some("tab") {
        tab_width = indent_size;
    }
    if indent_size.is_none() && (indent_style == Some(IndentStyle::Tab) || get("indent_size").as_deref() == Some("tab"))
    {
        indent_size = tab_width;
    }
    let end_of_line = match get("end_of_line").as_deref() {
        Some("lf") => Some(LineEnding::Lf),
        Some("crlf") => Some(LineEnding::CrLf),
        Some("cr") => Some(LineEnding::Cr),
        _ => None,
    };
    let charset = get("charset").filter(|c| charset_encoding(c).is_some());
    let max_line_length = get("max_line_length").and_then(|v| v.parse::<u32>().ok());
    EditorConfigProps {
        indent_style,
        indent_size,
        tab_width,
        end_of_line,
        charset,
        trim_trailing_whitespace: flag("trim_trailing_whitespace"),
        insert_final_newline: flag("insert_final_newline"),
        max_line_length,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    mtime: Option<SystemTime>,
    len: u64,
}

/// A parsed `.editorconfig` with the stamp it was read at; `None` = no such file.
type CachedFile = Option<(Stamp, Arc<ParsedFile>)>;

/// Resolves EditorConfig properties, caching parsed files.
#[derive(Default)]
pub struct EditorConfig {
    files: Mutex<HashMap<PathBuf, CachedFile>>,
}

impl EditorConfig {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drops every cached file (e.g. after "Clear caches").
    pub fn clear(&self) {
        self.files.lock().clear();
    }

    fn load(&self, path: &Path) -> Option<Arc<ParsedFile>> {
        let meta = std::fs::metadata(path).ok().filter(|m| m.is_file());
        let stamp = meta.as_ref().map(|m| Stamp { mtime: m.modified().ok(), len: m.len() });
        let mut files = self.files.lock();
        match (files.get(path), stamp) {
            (Some(None), None) => return None,
            (Some(Some((s, parsed))), Some(stamp)) if *s == stamp => return Some(parsed.clone()),
            _ => {}
        }
        let parsed = stamp.and_then(|stamp| {
            let text = std::fs::read_to_string(path).ok()?;
            Some((stamp, Arc::new(parse(&text))))
        });
        let result = parsed.as_ref().map(|(_, p)| p.clone());
        files.insert(path.to_path_buf(), parsed);
        result
    }

    /// Effective properties for `file` (absolute); `None` when no section applies.
    pub fn resolve(&self, file: &Path) -> Option<EditorConfigProps> {
        let props = props_from(&self.resolve_pairs(file)?);
        (!props.is_empty()).then_some(props)
    }

    /// Every `key = value` that applies to `file` (keys lower-cased), domain-specific ones
    /// (`quote_type`, `ij_*`) included; `None` when no section applies.
    pub fn resolve_pairs(&self, file: &Path) -> Option<HashMap<String, String>> {
        let mut chain: Vec<(PathBuf, Arc<ParsedFile>)> = Vec::new();
        for dir in file.ancestors().skip(1) {
            if let Some(parsed) = self.load(&dir.join(FILE_NAME)) {
                let root = parsed.root;
                chain.push((dir.to_path_buf(), parsed));
                if root {
                    break;
                }
            }
        }
        if chain.is_empty() {
            return None;
        }
        let mut map: HashMap<String, String> = HashMap::new();
        let mut matched = false;
        // Outermost first, so closer files override.
        for (dir, parsed) in chain.iter().rev() {
            let Ok(rel) = file.strip_prefix(dir) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            for section in &parsed.sections {
                if section.matcher.as_ref().is_some_and(|m| m.is_match(&rel)) {
                    matched = true;
                    apply_pairs(&mut map, &section.pairs);
                }
            }
        }
        matched.then_some(map)
    }
}

/// Bytes for a new, empty file honouring `charset` (a BOM for `utf-8-bom` and UTF-16).
pub fn new_file_bytes(props: Option<&EditorConfigProps>) -> Vec<u8> {
    match props.and_then(EditorConfigProps::encoding) {
        Some((enc, true)) => ide_vfs::encode("", enc, true).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Creates an empty file like `ide_vfs::create_file`, writing the BOM that
/// the file's EditorConfig `charset` asks for.
pub fn create_file(config: &EditorConfig, path: &Path) -> ide_core::IdeResult<()> {
    ide_vfs::create_file(path)?;
    let abs = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir()?.join(path) };
    let bytes = new_file_bytes(config.resolve(&abs).as_ref());
    if !bytes.is_empty() {
        std::fs::write(path, bytes)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn ranges_and_globs() {
        assert_eq!(expand_ranges("file{1..3}.txt"), "file{1,2,3}.txt");
        assert_eq!(expand_ranges("{a,b}.{x..y}"), "{a,b}.{x..y}");
        assert_eq!(expand_ranges("x{"), "x{");
        let m = |g: &str, p: &str| compile_glob(g).unwrap().is_match(p);
        assert!(m("*.rs", "src/deep/a.rs") && m("*.rs", "a.rs"));
        assert!(m("*", "Makefile") && m("*", "a/b/c"));
        assert!(m("src/*.rs", "src/a.rs") && !m("src/*.rs", "src/x/a.rs") && !m("src/*.rs", "lib/src/a.rs"));
        assert!(m("/src/**/*.rs", "src/x/a.rs") && !m("/src/**/*.rs", "lib/src/a.rs"));
        assert!(m("{package.json,.travis.yml}", "package.json") && m("{package.json,.travis.yml}", "x/.travis.yml"));
        assert!(m("*.{js,ts}", "a.ts") && !m("*.{js,ts}", "a.tsx"));
        assert!(m("f[ab].txt", "fa.txt") && !m("f[!ab].txt", "fa.txt") && m("f[!ab].txt", "fc.txt"));
        assert!(m("v{1..12}.md", "v10.md") && !m("v{1..12}.md", "v13.md"));
        assert!(m("?.c", "a.c") && !m("?.c", "ab.c"));
    }

    #[test]
    fn hierarchy_root_and_precedence() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().canonicalize().unwrap();
        write(
            &r.join(".editorconfig"),
            "# top\nroot = true\n\n[*]\nindent_style = space\nindent_size = 4\nend_of_line = lf\ncharset = utf-8\n\
             trim_trailing_whitespace = true\ninsert_final_newline = true\n\n[*.md]\ntrim_trailing_whitespace = false\n\n\
             [Makefile]\nindent_style = tab\n\n[*.go]\nindent_style = tab\ntab_width = 8\nindent_size = tab\n",
        );
        write(&r.join("sub/.editorconfig"), "[*.rs]\nindent_size = 2\n; comment\n[*.bat]\nend_of_line = CRLF\n");
        write(&r.join("sub/leaf/.editorconfig"), "root=true\n[*.rs]\nindent_size=unset\n");
        let ec = EditorConfig::new();

        let p = ec.resolve(&r.join("src/main.rs")).unwrap();
        assert_eq!(p.indent_style, Some(IndentStyle::Space));
        assert_eq!((p.indent_size, p.tab_width), (Some(4), Some(4)));
        assert_eq!(p.end_of_line, Some(LineEnding::Lf));
        assert_eq!(p.charset.as_deref(), Some("utf-8"));
        assert_eq!((p.trim_trailing_whitespace, p.insert_final_newline), (Some(true), Some(true)));

        assert_eq!(ec.resolve(&r.join("README.md")).unwrap().trim_trailing_whitespace, Some(false));
        let mk = ec.resolve(&r.join("Makefile")).unwrap();
        assert_eq!((mk.indent_style, mk.indent_size), (Some(IndentStyle::Tab), Some(4)));
        let go = ec.resolve(&r.join("cmd/x.go")).unwrap();
        assert_eq!((go.indent_size, go.tab_width), (Some(8), Some(8)));

        // Closer file overrides; outer sections still apply.
        let sub = ec.resolve(&r.join("sub/a.rs")).unwrap();
        assert_eq!((sub.indent_size, sub.tab_width, sub.indent_style), (Some(2), Some(2), Some(IndentStyle::Space)));
        assert_eq!(ec.resolve(&r.join("sub/x.bat")).unwrap().end_of_line, Some(LineEnding::CrLf));

        // `root = true` in leaf stops the search; `unset` clears.
        assert_eq!(ec.resolve(&r.join("sub/leaf/a.rs")), None);
        assert_eq!(ec.resolve(&r.join("sub/leaf/a.txt")), None);

        // Edits are picked up (cache keyed on mtime + size).
        write(&r.join("sub/.editorconfig"), "[*.rs]\nindent_size = 3\nmax_line_length = 100\n");
        let sub = ec.resolve(&r.join("sub/a.rs")).unwrap();
        assert_eq!((sub.indent_size, sub.max_line_length), (Some(3), Some(100)));
    }

    #[test]
    fn charset_and_new_files() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().canonicalize().unwrap();
        write(
            &r.join(".editorconfig"),
            "root = true\n[*.txt]\ncharset = utf-8-bom\n[*.u16]\ncharset = utf-16le\n[*.l1]\ncharset = latin1\n[*.bad]\ncharset = ebcdic\n",
        );
        let ec = EditorConfig::new();
        assert_eq!(ec.resolve(&r.join("a.txt")).unwrap().encoding(), Some(("utf-8", true)));
        assert_eq!(ec.resolve(&r.join("a.l1")).unwrap().encoding(), Some(("windows-1252", false)));
        assert_eq!(ec.resolve(&r.join("a.bad")), None);

        create_file(&ec, &r.join("new.txt")).unwrap();
        assert_eq!(std::fs::read(r.join("new.txt")).unwrap(), b"\xEF\xBB\xBF");
        create_file(&ec, &r.join("new.u16")).unwrap();
        assert_eq!(std::fs::read(r.join("new.u16")).unwrap(), [0xFF, 0xFE]);
        create_file(&ec, &r.join("new.l1")).unwrap();
        assert!(std::fs::read(r.join("new.l1")).unwrap().is_empty());
        assert!(create_file(&ec, &r.join("new.txt")).is_err(), "never truncates");
    }

    /// The labels of `ENCODING_CHOICES` in `src/platform/editorSettings.ts`, copied by hand.
    #[test]
    fn charset_maps_the_listed_encodings() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().canonicalize().unwrap();
        let listed = [
            ("utf-8", "utf-8"),
            ("utf-16le", "utf-16le"),
            ("utf-16be", "utf-16be"),
            ("gbk", "gbk"),
            ("gb18030", "gb18030"),
            ("big5", "big5"),
            ("shift_jis", "shift_jis"),
            ("euc-kr", "euc-kr"),
            ("windows-1252", "windows-1252"),
            ("iso-8859-1", "windows-1252"),
            ("ISO-8859-15", "iso-8859-15"),
            ("koi8-r", "koi8-r"),
        ];
        let sections: String =
            listed.iter().enumerate().map(|(i, (c, _))| format!("[*.e{i}]\ncharset = {c}\n")).collect();
        write(&r.join(".editorconfig"), &format!("root = true\n{sections}"));
        let ec = EditorConfig::new();
        for (i, (charset, label)) in listed.iter().enumerate() {
            let encoding = ec.resolve(&r.join(format!("a.e{i}"))).and_then(|p| p.encoding());
            assert_eq!(encoding.map(|(label, _)| label), Some(*label), "charset = {charset}");
            assert!(encoding_rs::Encoding::for_label(label.as_bytes()).is_some(), "{label} is a WHATWG label");
        }
    }
}
