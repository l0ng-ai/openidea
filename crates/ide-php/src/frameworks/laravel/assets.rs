//! The Vite assets of a Laravel project ([`ViteAssets`]), as Laravel's
//! documentation on asset bundling describes them:
//!
//! - **Entry points:** the `input` of the `laravel()` plugin in
//!   `vite.config.{js,ts,mjs,cjs,mts,cts}` (`laravel(['a.css', 'b.js'])` or
//!   `laravel({ input: [...] })`), read from the config's text.
//! - **The build manifest:** the source paths `public/build/manifest.json`
//!   (or `public/build/.vite/manifest.json`, Vite 5) lists.
//! - **Files:** the files below `resources/` other than views, which
//!   `Vite::asset()` can name once imported with `import.meta.glob`.
//!
//! Paths are relative to the project root, with `/`.

use std::path::{Path, PathBuf};

use ide_core::Range;

use crate::syntax::LineIndex;

/// The names of Vite's configuration file.
pub const VITE_CONFIGS: [&str; 6] =
    ["vite.config.js", "vite.config.ts", "vite.config.mjs", "vite.config.cjs", "vite.config.mts", "vite.config.cts"];

/// The most files listed below `resources/`.
const MAX_FILES: usize = 5000;

/// See the module documentation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ViteAssets {
    root: PathBuf,
    /// The configuration file, when there is one.
    pub config: Option<PathBuf>,
    /// The entry points, with the range of their strings in the config.
    entries: Vec<(String, Range)>,
    manifest: Vec<String>,
    files: Vec<String>,
}

/// An asset path of the completion tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetChild {
    pub segment: String,
    /// A file (not a folder).
    pub file: bool,
    /// An entry point of the config.
    pub entry: bool,
}

impl ViteAssets {
    /// The assets of the project at `root`; `text_of` reads a file.
    pub fn read(root: &Path, resources: &Path, text_of: impl Fn(&Path) -> Option<String>) -> Self {
        let mut out = Self { root: root.to_path_buf(), ..Self::default() };
        for name in VITE_CONFIGS {
            let path = root.join(name);
            if let Some(text) = text_of(&path) {
                out.entries = entry_points(&text);
                out.config = Some(crate::project::normalize(&path));
                break;
            }
        }
        for manifest in ["public/build/manifest.json", "public/build/.vite/manifest.json"] {
            let Some(text) = text_of(&root.join(manifest)) else { continue };
            if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(&text) {
                out.manifest = map.keys().cloned().collect();
                break;
            }
        }
        let mut files = Vec::new();
        list_files(root, resources, &resources.join("views"), &mut files);
        files.sort();
        out.files = files;
        out
    }

    /// The entry points of the config.
    pub fn entries(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(entry, _)| entry.as_str())
    }

    /// Whether `path` is an entry point.
    pub fn is_entry(&self, path: &str) -> bool {
        self.entries.iter().any(|(entry, _)| entry == clean(path))
    }

    /// The file `path` names, when it exists.
    pub fn file(&self, path: &str) -> Option<PathBuf> {
        let path = clean(path);
        if path.is_empty() || path.contains("..") {
            return None;
        }
        let file = self.root.join(path);
        file.is_file().then(|| crate::project::normalize(&file))
    }

    /// Whether `path` names a file, an entry point or a manifest entry.
    pub fn is_known(&self, path: &str) -> bool {
        let path = clean(path);
        self.is_entry(path) || self.manifest.iter().any(|known| known == path) || self.file(path).is_some()
    }

    /// The range of the entry point `path` in the config.
    pub fn entry_range(&self, path: &str) -> Option<Range> {
        self.entries.iter().find(|(entry, _)| entry == clean(path)).map(|(_, range)| *range)
    }

    /// Every path completion offers, sorted.
    fn paths(&self) -> Vec<&str> {
        let mut all: Vec<&str> = self
            .entries
            .iter()
            .map(|(entry, _)| entry.as_str())
            .chain(self.manifest.iter().map(String::as_str))
            .chain(self.files.iter().map(String::as_str))
            .collect();
        all.sort_unstable();
        all.dedup();
        all
    }

    /// The segments below the folder `parent` (`resources/css`; `None` for
    /// the root), entry points first.
    pub fn children(&self, parent: Option<&str>) -> Vec<AssetChild> {
        let mut out: Vec<AssetChild> = Vec::new();
        for path in self.paths() {
            let rest = match parent {
                Some(parent) => match path.strip_prefix(parent).and_then(|rest| rest.strip_prefix('/')) {
                    Some(rest) => rest,
                    None => continue,
                },
                None => path,
            };
            let (segment, file) = match rest.split_once('/') {
                Some((folder, _)) => (folder, false),
                None => (rest, true),
            };
            if segment.is_empty() || out.iter().any(|child| child.segment == segment && child.file == file) {
                continue;
            }
            out.push(AssetChild { segment: segment.to_owned(), file, entry: file && self.is_entry(path) });
        }
        out.sort_by(|a, b| (!a.entry, &a.segment).cmp(&(!b.entry, &b.segment)));
        out
    }
}

/// `./a/b` is `a/b`.
fn clean(path: &str) -> &str {
    path.trim_start_matches("./").trim_start_matches('/')
}

/// The files below `dir` (but not below `skip`), relative to `root`.
fn list_files(root: &Path, dir: &Path, skip: &Path, out: &mut Vec<String>) {
    if out.len() >= MAX_FILES || dir == skip {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            list_files(root, &path, skip, out);
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
}

/// The entry points of a Vite config's text, with the ranges of their
/// strings.
pub fn entry_points(text: &str) -> Vec<(String, Range)> {
    let Some(call) = text.find("laravel(") else { return Vec::new() };
    let open = call + "laravel(".len();
    let rest = text[open..].trim_start();
    let start = text.len() - rest.len();
    let span = if rest.starts_with('{') {
        // `input: …` of the options object.
        let Some(object_end) = balanced_end(text, start) else { return Vec::new() };
        let object = &text[start..object_end];
        let Some(input) = find_key(object, "input") else { return Vec::new() };
        let value = start + input;
        let value_text = text[value..].trim_start();
        let value = text.len() - value_text.len();
        value..value_end(text, value)
    } else {
        start..value_end(text, start)
    };
    let lines = LineIndex::new(text);
    strings(text, span).into_iter().map(|(value, start, end)| (value, lines.range(start, end))).collect()
}

/// The offset after the `:` of `key` in `object`.
fn find_key(object: &str, key: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(at) = object[from..].find(key) {
        let start = from + at;
        let end = start + key.len();
        let before = object[..start].chars().next_back();
        let quoted = matches!(before, Some('\'' | '"'));
        let after = object[end..].trim_start_matches(['\'', '"']).trim_start();
        let word_start = !before.is_some_and(|c| c.is_alphanumeric() || c == '_') || quoted;
        if word_start && after.starts_with(':') {
            return Some(object.len() - after.len() + 1);
        }
        from = end;
    }
    None
}

/// The end of the value starting at `start`: a bracketed array or a string.
fn value_end(text: &str, start: usize) -> usize {
    match text.as_bytes().get(start) {
        Some(b'[' | b'{') => balanced_end(text, start).unwrap_or(text.len()),
        Some(quote @ (b'\'' | b'"' | b'`')) => {
            text[start + 1..].find(*quote as char).map_or(text.len(), |end| start + 1 + end + 1)
        }
        _ => start,
    }
}

/// The offset after the bracket closing the one at `open`.
fn balanced_end(text: &str, open: usize) -> Option<usize> {
    let b = text.as_bytes();
    let mut depth = 0usize;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            b'[' | b'{' | b'(' => depth += 1,
            b']' | b'}' | b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            quote @ (b'\'' | b'"' | b'`') => {
                i += 1;
                while i < b.len() && b[i] != quote {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// The quoted strings of `text[span]`: value and content range.
fn strings(text: &str, span: std::ops::Range<usize>) -> Vec<(String, u32, u32)> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = span.start;
    while i < span.end.min(b.len()) {
        let quote = b[i];
        if matches!(quote, b'\'' | b'"' | b'`') {
            let start = i + 1;
            let mut j = start;
            while j < b.len() && b[j] != quote {
                j += 1;
            }
            out.push((text[start..j.min(b.len())].to_owned(), start as u32, j as u32));
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::Pos;

    #[test]
    fn reads_entry_points_of_both_forms() {
        let object = "export default defineConfig({\n  plugins: [\n    laravel({\n      input: ['resources/css/app.css', \"resources/js/app.js\"],\n      refresh: true,\n    }),\n  ],\n});\n";
        let found = entry_points(object);
        let names: Vec<&str> = found.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["resources/css/app.css", "resources/js/app.js"]);
        assert_eq!(found[0].1, Range::new(Pos::new(3, 15), Pos::new(3, 36)));
        let list = "plugins: [laravel(['resources/js/app.ts'])]";
        assert_eq!(entry_points(list).len(), 1);
        let single = "laravel({ refresh: true, 'input': 'resources/js/main.js' })";
        assert_eq!(entry_points(single)[0].0, "resources/js/main.js");
        assert!(entry_points("export default {}").is_empty());
    }
}
