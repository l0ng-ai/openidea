//! The environment keys of a Laravel project ([`EnvKeys`]): the variables
//! `.env` and `.env.example` at the project root set, as `vlucas/phpdotenv`
//! (which Laravel loads) reads them: `KEY=value` and `export KEY=value`
//! lines, quoted values or unquoted ones up to a ` #` comment, `#` comment
//! lines skipped.

use std::path::{Path, PathBuf};

use ide_core::{FileEdit, Pos, Range, TextEdit, WorkspaceEdit};

use crate::syntax::LineIndex;

/// The files read, in the order their values are preferred.
pub const ENV_FILES: [&str; 2] = [".env", ".env.example"];

/// See the module documentation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EnvKeys {
    /// In file order (`.env` first), then line order.
    entries: Vec<EnvEntry>,
    /// The files that exist.
    files: Vec<PathBuf>,
    /// `.env.example`, and its text when it exists.
    example: PathBuf,
    example_text: Option<String>,
}

/// One `KEY=value` line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvEntry {
    pub key: String,
    /// The value without quotes and comment (may be empty).
    pub value: String,
    pub path: PathBuf,
    /// The key on its line.
    pub range: Range,
    /// The line is in `.env.example`.
    pub example: bool,
}

/// The key and value of a line of an environment file, and the key's byte
/// range in the line.
pub fn parse_line(line: &str) -> Option<(String, String, usize, usize)> {
    let trimmed = line.trim_start();
    let mut start = line.len() - trimmed.len();
    let mut rest = trimmed;
    if let Some(after) = rest.strip_prefix("export ") {
        let after_trim = after.trim_start();
        start += rest.len() - after_trim.len();
        rest = after_trim;
    }
    if rest.starts_with('#') {
        return None;
    }
    let (name, value) = rest.split_once('=')?;
    let key = name.trim_end();
    let valid = key.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
    if !valid {
        return None;
    }
    let value = value.trim();
    let value = match value.chars().next() {
        Some(quote @ ('"' | '\'')) => {
            let inner = &value[1..];
            inner.find(quote).map_or(inner, |end| &inner[..end])
        }
        _ => value.split(" #").next().unwrap_or(value).trim(),
    };
    Some((key.to_owned(), value.to_owned(), start, start + key.len()))
}

impl EnvKeys {
    /// The keys of the files of [`ENV_FILES`] in `root`; `text_of` reads a
    /// file.
    pub fn read(root: &Path, text_of: impl Fn(&Path) -> Option<String>) -> Self {
        let mut out = Self { example: root.join(ENV_FILES[1]), ..Self::default() };
        for name in ENV_FILES {
            let path = root.join(name);
            let Some(text) = text_of(&path) else { continue };
            let example = name == ENV_FILES[1];
            let lines = LineIndex::new(&text);
            let mut offset = 0usize;
            for line in text.split('\n') {
                if let Some((key, value, start, end)) = parse_line(line.trim_end_matches('\r')) {
                    let range = lines.range((offset + start) as u32, (offset + end) as u32);
                    out.entries.push(EnvEntry { key, value, path: path.clone(), range, example });
                }
                offset += line.len() + 1;
            }
            out.files.push(path);
            if example {
                out.example_text = Some(text);
            }
        }
        out
    }

    /// Whether `.env` or `.env.example` exists.
    pub fn has_files(&self) -> bool {
        !self.files.is_empty()
    }

    pub fn has_example(&self) -> bool {
        self.example_text.is_some()
    }

    pub fn entries(&self) -> &[EnvEntry] {
        &self.entries
    }

    /// Every key once, sorted.
    pub fn keys(&self) -> Vec<&str> {
        let mut keys: Vec<&str> = self.entries.iter().map(|entry| entry.key.as_str()).collect();
        keys.sort_unstable();
        keys.dedup();
        keys
    }

    /// The lines setting `key` (`.env` first).
    pub fn get<'s>(&'s self, key: &'s str) -> impl Iterator<Item = &'s EnvEntry> + 's {
        self.entries.iter().filter(move |entry| entry.key == key)
    }

    pub fn contains(&self, key: &str) -> bool {
        self.get(key).next().is_some()
    }

    /// Whether `.env.example` sets `key`.
    pub fn in_example(&self, key: &str) -> bool {
        self.get(key).any(|entry| entry.example)
    }

    /// The value of `key`, from `.env` before `.env.example`.
    pub fn value(&self, key: &str) -> Option<&str> {
        self.entries.iter().find(|entry| entry.key == key).map(|entry| entry.value.as_str())
    }

    /// The edit adding `KEY=` at the end of `.env.example` (creating it
    /// when it doesn't exist).
    pub fn add_to_example(&self, key: &str) -> WorkspaceEdit {
        let mut files = Vec::new();
        let (at, prefix) = match &self.example_text {
            Some(text) => {
                let at = LineIndex::new(text).pos(text.len() as u32);
                let newline = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
                (at, newline)
            }
            None => {
                files.push(FileEdit::Create { path: self.example.clone().into(), overwrite: false });
                (Pos::new(0, 0), "")
            }
        };
        let edit = TextEdit { range: Range::new(at, at), new_text: format!("{prefix}{key}=\n") };
        files.push(FileEdit::Edit { path: self.example.clone().into(), edits: vec![edit], version: None });
        WorkspaceEdit { files, ..WorkspaceEdit::default() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lines() {
        assert_eq!(parse_line("APP_NAME=\"Laravel Blog\""), Some(("APP_NAME".into(), "Laravel Blog".into(), 0, 8)));
        assert_eq!(
            parse_line("  export DB_HOST=127.0.0.1 # local"),
            Some(("DB_HOST".into(), "127.0.0.1".into(), 9, 16))
        );
        assert_eq!(parse_line("APP_KEY="), Some(("APP_KEY".into(), String::new(), 0, 7)));
        assert_eq!(parse_line("# APP_NAME=x"), None);
        assert_eq!(parse_line("not a line"), None);
        assert_eq!(parse_line("1X=2"), None);
    }

    #[test]
    fn reads_both_files_and_adds_keys_to_the_example() {
        let root = Path::new("/p");
        let text_of = |path: &Path| match path.file_name()?.to_str()? {
            ".env" => Some("APP_NAME=Blog\nSECRET=x\n".to_owned()),
            ".env.example" => Some("APP_NAME=Laravel\n# c\nAPP_ENV=local".to_owned()),
            _ => None,
        };
        let keys = EnvKeys::read(root, text_of);
        assert_eq!(keys.keys(), ["APP_ENV", "APP_NAME", "SECRET"]);
        assert_eq!(keys.value("APP_NAME"), Some("Blog"));
        assert_eq!(keys.value("APP_ENV"), Some("local"));
        assert!(keys.in_example("APP_NAME") && !keys.in_example("SECRET"));
        let env = keys.get("APP_ENV").next().unwrap();
        assert_eq!(env.range, Range::new(Pos::new(2, 0), Pos::new(2, 7)));
        let edit = keys.add_to_example("NEW_KEY");
        let [FileEdit::Edit { edits, .. }] = edit.files.as_slice() else { panic!("{edit:?}") };
        assert_eq!(edits[0].new_text, "\nNEW_KEY=\n");
        assert_eq!(edits[0].range.start, Pos::new(2, 13));
        // Without `.env.example`: created first.
        let keys = EnvKeys::read(root, |path| (path.file_name()? == ".env").then(|| "A=1\n".to_owned()));
        assert!(keys.has_files() && !keys.has_example());
        let edit = keys.add_to_example("B");
        assert!(matches!(edit.files.as_slice(), [FileEdit::Create { .. }, FileEdit::Edit { .. }]));
    }
}
