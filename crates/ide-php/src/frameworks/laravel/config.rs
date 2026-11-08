//! The configuration keys of a Laravel project ([`ConfigKeys`]): the
//! dotted keys of the arrays the files of `config/` return, as Laravel's
//! `LoadConfiguration` bootstrapper names them (`config/app.php` holds
//! `app.*`, `config/services/mail.php` holds `services.mail.*`), each with
//! the place declaring it and the source text of its value.
//!
//! Only string keys of array literals count; a value that isn't an array
//! literal (`env(…)`, a function call) ends the nesting.

use std::path::{Path, PathBuf};

use ide_core::Range;
use mago_span::HasSpan;
use mago_syntax::cst::{ArrayElement, Expression, Literal, Statement};

use crate::syntax::ParsedFile;

/// The longest value text kept for completion details.
const MAX_VALUE: usize = 48;

/// See the module documentation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConfigKeys {
    /// Sorted by key; a file's entry comes before its keys.
    entries: Vec<ConfigEntry>,
}

/// One configuration key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigEntry {
    /// The full dotted key (`app.name`); a file's entry is its name
    /// (`app`, `services.mail`).
    pub key: String,
    pub path: PathBuf,
    /// The key's string literal without its quotes; the start of the file
    /// for a file's entry.
    pub range: Range,
    /// The source text of the value on one line, shortened (`env('APP_NAME',
    /// 'Laravel')`); `None` for arrays and files.
    pub value: Option<String>,
    /// The value is an array literal (or the entry is a file): it has keys
    /// of its own.
    pub is_array: bool,
    /// A file's entry rather than an array key.
    pub is_file: bool,
}

impl ConfigEntry {
    /// The last segment of the key.
    pub fn segment(&self) -> &str {
        self.key.rsplit('.').next().unwrap_or(&self.key)
    }
}

/// A key literal found in a configuration file: its full key and the byte
/// range of its content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeclaredKey {
    pub key: String,
    pub start: u32,
    pub end: u32,
}

impl ConfigKeys {
    /// The keys of the files below `dir`; `text_of` reads a file (an open
    /// buffer first). Files are visited in path order.
    pub fn read(dir: &Path, text_of: impl Fn(&Path) -> Option<String>) -> Self {
        let mut files = Vec::new();
        config_files(dir, dir, &mut files);
        files.sort();
        let mut entries = Vec::new();
        for (prefix, path) in files {
            let Some(text) = text_of(&path) else { continue };
            let parsed = ParsedFile::parse("config.php", text);
            entries.extend(Self::file_entries(&prefix, &path, &parsed));
        }
        Self::from_entries(entries)
    }

    /// The entries of one file whose keys start with `prefix` (the file's
    /// name relative to the configuration folder, dotted).
    pub fn file_entries(prefix: &str, path: &Path, parsed: &ParsedFile) -> Vec<ConfigEntry> {
        let mut out = vec![ConfigEntry {
            key: prefix.to_owned(),
            path: path.to_path_buf(),
            range: Range::default(),
            value: None,
            is_array: true,
            is_file: true,
        }];
        if let Some(array) = returned_array(parsed) {
            collect(parsed, path, prefix, array, &mut out);
        }
        out
    }

    pub fn from_entries(mut entries: Vec<ConfigEntry>) -> Self {
        entries.sort_by(|a, b| a.key.cmp(&b.key));
        entries.dedup_by(|later, earlier| later.key == earlier.key);
        Self { entries }
    }

    pub fn entries(&self) -> &[ConfigEntry] {
        &self.entries
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&ConfigEntry> {
        let at = self.entries.binary_search_by(|entry| entry.key.as_str().cmp(key)).ok()?;
        self.entries.get(at)
    }

    /// The entries directly below `parent`. `None` gives the files, whose
    /// names may have dots of their own (`services.mail` is the file
    /// `config/services/mail.php`); such a file is below its folder's
    /// segment too, with its other segments (`mail` below `services`).
    pub fn children<'s>(&'s self, parent: Option<&'s str>) -> impl Iterator<Item = &'s ConfigEntry> + 's {
        self.entries.iter().filter(move |entry| match parent {
            None => entry.is_file,
            Some(parent) => entry
                .key
                .strip_prefix(parent)
                .and_then(|rest| rest.strip_prefix('.'))
                .is_some_and(|rest| !rest.is_empty() && (!rest.contains('.') || entry.is_file)),
        })
    }

    /// The file entry a key belongs to: the longest file name that is
    /// the key or a dotted prefix of it.
    pub fn file_of(&self, key: &str) -> Option<&ConfigEntry> {
        self.entries
            .iter()
            .filter(|entry| entry.is_file)
            .filter(|entry| key == entry.key || key.starts_with(&format!("{}.", entry.key)))
            .max_by_key(|entry| entry.key.len())
    }
}

/// The dotted name (`services.mail`) of a configuration file below `dir`.
pub fn file_prefix(dir: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(dir).ok()?;
    let rel = rel.to_str()?.strip_suffix(".php")?;
    Some(rel.replace(['\\', '/'], "."))
}

/// The key literal of a configuration file at byte `offset` (inside its
/// quotes), as a full key.
pub fn declared_key_at(parsed: &ParsedFile, prefix: &str, offset: u32) -> Option<DeclaredKey> {
    let array = returned_array(parsed)?;
    find_key(prefix, array, offset)
}

fn config_files(dir: &Path, base: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = crate::project::normalize(&entry.path());
        if path.is_dir() {
            config_files(&path, base, out);
        } else if path.extension().is_some_and(|e| e == "php")
            && let Some(prefix) = file_prefix(base, &path)
        {
            out.push((prefix, path));
        }
    }
}

/// The array literal the file's top-level `return` returns.
fn returned_array<'a>(parsed: &'a ParsedFile) -> Option<&'a Expression<'a>> {
    parsed.program().statements.iter().find_map(|statement| match statement {
        Statement::Return(r#return) => r#return.value.filter(|value| is_array(value)),
        _ => None,
    })
}

fn is_array(expr: &Expression<'_>) -> bool {
    matches!(expr, Expression::Array(_) | Expression::LegacyArray(_))
}

fn elements<'a>(expr: &'a Expression<'a>) -> Vec<&'a ArrayElement<'a>> {
    match expr {
        Expression::Array(array) => array.elements.iter().collect(),
        Expression::LegacyArray(array) => array.elements.iter().collect(),
        _ => Vec::new(),
    }
}

/// A string literal key's value and the byte range of its content.
fn string_key(key: &Expression<'_>) -> Option<(String, u32, u32)> {
    let Expression::Literal(Literal::String(string)) = key else { return None };
    let value = String::from_utf8_lossy(string.value?).into_owned();
    let span = string.span();
    Some((value, span.start.offset + 1, span.end.offset.saturating_sub(1)))
}

fn collect(parsed: &ParsedFile, path: &Path, prefix: &str, array: &Expression<'_>, out: &mut Vec<ConfigEntry>) {
    let lines = parsed.line_index();
    for element in elements(array) {
        let ArrayElement::KeyValue(element) = element else { continue };
        let Some((name, start, end)) = string_key(element.key) else { continue };
        let key = format!("{prefix}.{name}");
        let nested = is_array(element.value);
        let value = (!nested).then(|| value_text(parsed, element.value));
        out.push(ConfigEntry {
            key: key.clone(),
            path: path.to_path_buf(),
            range: lines.range(start, end),
            value,
            is_array: nested,
            is_file: false,
        });
        if nested {
            collect(parsed, path, &key, element.value, out);
        }
    }
}

fn find_key(prefix: &str, array: &Expression<'_>, offset: u32) -> Option<DeclaredKey> {
    for element in elements(array) {
        let ArrayElement::KeyValue(element) = element else { continue };
        let Some((name, start, end)) = string_key(element.key) else { continue };
        let key = format!("{prefix}.{name}");
        if start <= offset && offset <= end {
            return Some(DeclaredKey { key, start, end });
        }
        let span = element.value.span();
        if is_array(element.value) && span.start.offset <= offset && offset <= span.end.offset {
            return find_key(&key, element.value, offset);
        }
    }
    None
}

/// The value's source on one line, shortened.
fn value_text(parsed: &ParsedFile, value: &Expression<'_>) -> String {
    let span = value.span();
    let text = parsed.text().get(span.start.offset as usize..span.end.offset as usize).unwrap_or_default();
    let line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() > MAX_VALUE {
        let short: String = line.chars().take(MAX_VALUE - 1).collect();
        format!("{short}…")
    } else {
        line
    }
}
