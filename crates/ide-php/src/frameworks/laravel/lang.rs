//! The translation keys of a Laravel project ([`Translations`]), per
//! locale, as Laravel's translator finds them (Laravel's documentation on
//! localization):
//!
//! - **PHP files:** `lang/<locale>/<group>.php` returns an array; its keys
//!   are `<group>.<key>`, nested arrays dotted (`messages.status.draft`). A
//!   file in a subfolder is `<folder>/<group>`.
//! - **JSON files:** `lang/<locale>.json` maps whole strings (`"Read more"`)
//!   to their translations; such keys aren't split at dots.
//! - **Namespaces:** `lang/vendor/<package>/<locale>/<group>.php` overrides a
//!   package's lines (`package::group.key`), and modules have their own
//!   `lang` (or `resources/lang`) folder under the module's lower-case name.
//!
//! [`Translations::create`] builds the edit that adds a key to the files
//! of some locales: into the right nested array of a group file (created
//! when missing), or into the JSON file.

use std::path::{Path, PathBuf};

use ide_core::{FileEdit, Range, TextEdit, WorkspaceEdit};
use mago_span::HasSpan;
use mago_syntax::cst::{ArrayElement, Expression, Literal, Statement};

use super::LaravelProject;
use super::config::ConfigKeys;
use crate::syntax::{LineIndex, ParsedFile};

/// See the module documentation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Translations {
    /// Sorted by key, then locale.
    entries: Vec<TransEntry>,
    /// The locales found, sorted.
    locales: Vec<String>,
    /// The folders holding the locales: `None` for the application's, the
    /// namespace otherwise.
    dirs: Vec<(Option<String>, PathBuf)>,
}

/// One key in one locale.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransEntry {
    /// The full key (`messages.status.draft`, `billing::invoices.title`,
    /// `Read more`); a group file's entry is the group (`messages`).
    pub key: String,
    pub locale: String,
    pub path: PathBuf,
    /// The key's literal without its quotes; the start of the file for a
    /// group.
    pub range: Range,
    /// The translation (`None` for arrays and groups).
    pub text: Option<String>,
    /// The value is an array (or the entry is a group): keys below it.
    pub is_group: bool,
    /// A group file's entry.
    pub is_file: bool,
    /// A key of a JSON file.
    pub json: bool,
}

impl TransEntry {
    /// The last segment of a PHP key.
    pub fn segment(&self) -> &str {
        if self.json { &self.key } else { self.key.rsplit('.').next().unwrap_or(&self.key) }
    }
}

/// Whether `key` names a PHP group key (`group.key`) rather than a JSON
/// string: no white space, dotted, every segment a word.
pub fn is_group_key(key: &str) -> bool {
    let local = key.split_once("::").map_or(key, |(_, local)| local);
    local.contains('.')
        && local
            .split('.')
            .all(|segment| !segment.is_empty() && segment.chars().all(|c| c.is_alphanumeric() || "_-/".contains(c)))
}

impl Translations {
    /// The translations of the project; `text_of` reads a file.
    pub fn read(project: &LaravelProject, text_of: impl Fn(&Path) -> Option<String>) -> Self {
        let mut dirs: Vec<(Option<String>, PathBuf)> = vec![(None, project.paths.lang.clone())];
        if let Ok(vendor) = std::fs::read_dir(project.paths.lang.join("vendor")) {
            let mut packages: Vec<_> = vendor.flatten().filter(|e| e.path().is_dir()).collect();
            packages.sort_by_key(|entry| entry.file_name());
            for package in packages {
                dirs.push((Some(package.file_name().to_string_lossy().into_owned()), package.path()));
            }
        }
        for module in project.modules.iter().filter(|module| module.enabled) {
            for sub in ["lang", "resources/lang"] {
                let dir = module.path.join(sub);
                if dir.is_dir() {
                    dirs.push((Some(module.name.to_lowercase()), dir));
                    break;
                }
            }
        }
        let mut out = Self { dirs: Vec::new(), ..Self::default() };
        for (namespace, dir) in dirs {
            let dir = crate::project::normalize(&dir);
            out.read_dir(namespace.as_deref(), &dir, &text_of);
            out.dirs.push((namespace, dir));
        }
        out.entries.sort_by(|a, b| (&a.key, &a.locale).cmp(&(&b.key, &b.locale)));
        out.entries.dedup_by(|later, earlier| later.key == earlier.key && later.locale == earlier.locale);
        out.locales.sort();
        out.locales.dedup();
        out
    }

    fn read_dir(&mut self, namespace: Option<&str>, dir: &Path, text_of: &impl Fn(&Path) -> Option<String>) {
        let Ok(found) = std::fs::read_dir(dir) else { return };
        let mut found: Vec<_> = found.flatten().map(|entry| entry.path()).collect();
        found.sort();
        let prefix = |group: &str| match namespace {
            Some(namespace) => format!("{namespace}::{group}"),
            None => group.to_owned(),
        };
        for path in found {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if path.is_dir() {
                if name == "vendor" || name.starts_with('.') {
                    continue;
                }
                self.locales.push(name.clone());
                let mut files = Vec::new();
                php_files_below(&path, &path, &mut files);
                files.sort();
                for (group, file) in files {
                    let Some(text) = text_of(&file) else { continue };
                    let parsed = ParsedFile::parse("lang.php", text);
                    let file = crate::project::normalize(&file);
                    for entry in ConfigKeys::file_entries(&prefix(&group), &file, &parsed) {
                        let text = entry.value.as_deref().and_then(unquote);
                        self.entries.push(TransEntry {
                            key: entry.key,
                            locale: name.clone(),
                            path: entry.path,
                            range: entry.range,
                            text,
                            is_group: entry.is_array,
                            is_file: entry.is_file,
                            json: false,
                        });
                    }
                }
            } else if namespace.is_none()
                && let Some(locale) = name.strip_suffix(".json")
            {
                let Some(text) = text_of(&path) else { continue };
                self.locales.push(locale.to_owned());
                let path = crate::project::normalize(&path);
                self.entries.extend(json_entries(locale, &path, &text));
            }
        }
    }

    pub fn entries(&self) -> &[TransEntry] {
        &self.entries
    }

    pub fn locales(&self) -> &[String] {
        &self.locales
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Whether some JSON file exists.
    pub fn has_json(&self) -> bool {
        self.entries.iter().any(|entry| entry.json)
    }

    /// The entries of `key`, one per locale that has it.
    pub fn get<'s>(&'s self, key: &'s str) -> impl Iterator<Item = &'s TransEntry> + 's {
        let start = self.entries.partition_point(|entry| entry.key.as_str() < key);
        self.entries[start..].iter().take_while(move |entry| entry.key == key)
    }

    pub fn contains(&self, key: &str) -> bool {
        self.get(key).next().is_some()
    }

    /// The group file entries a key belongs to: the longest group that is
    /// the key or a dotted prefix of it (any locale).
    pub fn group_of(&self, key: &str) -> Option<&TransEntry> {
        self.entries
            .iter()
            .filter(|entry| entry.is_file && (key == entry.key || key.starts_with(&format!("{}.", entry.key))))
            .max_by_key(|entry| entry.key.len())
    }

    /// The PHP entries directly below `parent` (one per key); `None` gives
    /// the groups.
    pub fn children<'s>(&'s self, parent: Option<&'s str>) -> Vec<&'s TransEntry> {
        let mut out: Vec<&TransEntry> = self
            .entries
            .iter()
            .filter(|entry| !entry.json)
            .filter(|entry| match parent {
                None => entry.is_file,
                Some(parent) => entry
                    .key
                    .strip_prefix(parent)
                    .and_then(|rest| rest.strip_prefix('.'))
                    .is_some_and(|rest| !rest.is_empty() && !rest.contains('.')),
            })
            .collect();
        out.dedup_by(|later, earlier| later.key == earlier.key);
        out
    }

    /// The JSON keys (one per key).
    pub fn json_keys(&self) -> Vec<&TransEntry> {
        let mut out: Vec<&TransEntry> = self.entries.iter().filter(|entry| entry.json).collect();
        out.dedup_by(|later, earlier| later.key == earlier.key);
        out
    }

    /// The folder of `namespace`'s locales (`None`: the application's).
    fn dir(&self, namespace: Option<&str>) -> Option<&Path> {
        self.dirs.iter().find(|(known, _)| known.as_deref() == namespace).map(|(_, dir)| dir.as_path())
    }

    /// Whether the namespace of `key` (if it has one) is known.
    pub fn knows_namespace_of(&self, key: &str) -> bool {
        match key.split_once("::") {
            Some((namespace, _)) => self.dir(Some(namespace)).is_some(),
            None => true,
        }
    }

    /// The group (`messages`, `billing::invoices`) of the group file `path`
    /// and its locale.
    pub fn group_of_file(&self, path: &Path) -> Option<(String, String)> {
        let path = crate::project::normalize(path);
        self.dirs.iter().find_map(|(namespace, dir)| {
            let rel = path.strip_prefix(dir).ok()?.to_str()?.replace('\\', "/");
            let (locale, group) = rel.split_once('/')?;
            let group = group.strip_suffix(".php")?;
            if locale == "vendor" {
                return None;
            }
            let group = match namespace {
                Some(namespace) => format!("{namespace}::{group}"),
                None => group.to_owned(),
            };
            Some((group, locale.to_owned()))
        })
    }

    /// The edit adding `key` with each `(locale, text)` to the locale's
    /// files: the group file (and nested arrays) of a group key, else the
    /// locale's JSON file (application keys only). `None` when the key's
    /// namespace is unknown, or a group key's place is taken by a string.
    pub fn create(&self, key: &str, texts: &[(String, String)]) -> Option<WorkspaceEdit> {
        let (namespace, local) = match key.split_once("::") {
            Some((namespace, local)) => (Some(namespace), local),
            None => (None, key),
        };
        let dir = self.dir(namespace)?.to_path_buf();
        let group_key = is_group_key(key) && !self.get(key).any(|entry| entry.json);
        if !group_key && namespace.is_some() {
            return None;
        }
        let mut files = Vec::new();
        for (locale, text) in texts {
            if self.get(key).any(|entry| entry.locale == *locale) {
                continue;
            }
            if group_key {
                files.extend(self.create_in_group(&dir, namespace, locale, local, text)?);
            } else {
                files.extend(create_in_json(&dir.join(format!("{locale}.json")), key, text));
            }
        }
        Some(WorkspaceEdit { files, ..WorkspaceEdit::default() })
    }

    fn create_in_group(
        &self,
        dir: &Path,
        namespace: Option<&str>,
        locale: &str,
        local: &str,
        text: &str,
    ) -> Option<Vec<FileEdit>> {
        // The longest group of this locale the key is in, else its first
        // segment as a new file.
        let full = |group: &str| match namespace {
            Some(namespace) => format!("{namespace}::{group}"),
            None => group.to_owned(),
        };
        let group = self
            .entries
            .iter()
            .filter(|entry| entry.is_file && entry.locale == locale)
            .filter_map(|entry| {
                let group = match namespace {
                    Some(namespace) => entry.key.strip_prefix(&format!("{namespace}::"))?,
                    None if entry.key.contains("::") => return None,
                    None => entry.key.as_str(),
                };
                local.starts_with(&format!("{group}.")).then(|| group.to_owned())
            })
            .max_by_key(String::len);
        let path = match &group {
            Some(group) => self.get(&full(group)).find(|entry| entry.locale == locale)?.path.clone(),
            None => dir.join(locale).join(format!("{}.php", local.split('.').next()?)),
        };
        let group = group.unwrap_or_else(|| local.split('.').next().unwrap_or_default().to_owned());
        let segments: Vec<&str> = local[group.len() + 1..].split('.').collect();
        let existing = std::fs::read_to_string(&path).ok().map(|text| text.replace("\r\n", "\n"));
        let Some(source) = existing else {
            let body = nested(&segments, text);
            let content = format!("<?php\n\nreturn [\n    {body},\n];\n");
            return Some(vec![
                FileEdit::Create { path: path.clone().into(), overwrite: false },
                insert(&path, "", 0, &content),
            ]);
        };
        let parsed = ParsedFile::parse("lang.php", source.as_str());
        let array = returned_array(&parsed)?;
        let (array, rest) = deepest(array, &segments)?;
        let span = array.span();
        let close = span.end.offset as usize - 1;
        let open_line_indent = indent_at(&source, close);
        let inner_indent = format!("{open_line_indent}    ");
        let before = source[..close].trim_end();
        let at = before.len();
        let empty = before.ends_with('[') || before.ends_with('(');
        let comma = if empty || before.ends_with(',') { "" } else { "," };
        let entry = nested(rest, text);
        let new_text = if empty {
            format!("\n{inner_indent}{entry},\n{open_line_indent}")
        } else {
            format!("{comma}\n{inner_indent}{entry},")
        };
        Some(vec![insert(&path, &source, at as u32, &new_text)])
    }
}

impl crate::engine::PhpEngine {
    /// The locales of the Laravel project's translations; `None` outside
    /// Laravel projects.
    pub fn laravel_locales(&self) -> Option<Vec<String>> {
        Some(self.laravel_translations()?.locales().to_vec())
    }

    /// The "Create translation key" action: the edit adding `key` with the
    /// text of each `(locale, text)` to that locale's files (see
    /// [`Translations::create`]). `None` outside Laravel projects or when
    /// the key can't be added.
    pub fn laravel_create_translation(&self, key: &str, texts: &[(String, String)]) -> Option<WorkspaceEdit> {
        self.laravel_translations()?.create(key, texts)
    }
}

/// The text of a PHP string literal's source, unescaped simply.
fn unquote(value: &str) -> Option<String> {
    let quote = value.chars().next().filter(|c| *c == '\'' || *c == '"')?;
    let inner = value.strip_prefix(quote)?.strip_suffix(quote).unwrap_or(&value[1..]);
    Some(inner.replace(&format!("\\{quote}"), &quote.to_string()))
}

/// `'a' => ['b' => 'text']` for segments `a`, `b`.
fn nested(segments: &[&str], text: &str) -> String {
    let quoted = |s: &str| format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"));
    match segments {
        [] => quoted(text),
        [last] => format!("{} => {}", quoted(last), quoted(text)),
        [first, rest @ ..] => format!("{} => [{}]", quoted(first), nested(rest, text)),
    }
}

/// The indentation of the line holding byte `at`.
fn indent_at(text: &str, at: usize) -> String {
    let line_start = text[..at].rfind('\n').map_or(0, |n| n + 1);
    text[line_start..].chars().take_while(|c| *c == ' ' || *c == '\t').collect()
}

/// The deepest array of `segments` that exists below `array` (each but the
/// last segment may be an array), and the segments left. `None` when a
/// segment before the last holds something else than an array, or the
/// whole key exists.
fn deepest<'a, 's>(array: &'a Expression<'a>, segments: &'s [&'s str]) -> Option<(&'a Expression<'a>, &'s [&'s str])> {
    let (first, rest) = segments.split_first()?;
    let found = elements(array).into_iter().find_map(|element| {
        let ArrayElement::KeyValue(element) = element else { return None };
        let Expression::Literal(Literal::String(key)) = element.key else { return None };
        (key.value.map(|value| String::from_utf8_lossy(value).into_owned()).as_deref() == Some(*first))
            .then_some(element.value)
    });
    match found {
        None => Some((array, segments)),
        Some(value) if is_array(value) && !rest.is_empty() => deepest(value, rest),
        Some(_) => None,
    }
}

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

/// An edit inserting `new_text` at byte `at` of `path`, whose text is
/// `text`.
fn insert(path: &Path, text: &str, at: u32, new_text: &str) -> FileEdit {
    let pos = LineIndex::new(text).pos(at);
    let edit = TextEdit { range: Range::new(pos, pos), new_text: new_text.to_owned() };
    FileEdit::Edit { path: path.to_path_buf().into(), edits: vec![edit], version: None }
}

/// The edits adding `"key": "text"` to the JSON file `path`.
fn create_in_json(path: &Path, key: &str, text: &str) -> Vec<FileEdit> {
    let quoted = |s: &str| serde_json::to_string(s).unwrap_or_default();
    let line = format!("{}: {}", quoted(key), quoted(text));
    match std::fs::read_to_string(path).ok().map(|text| text.replace("\r\n", "\n")) {
        Some(source) => {
            let Some(close) = source.rfind('}') else { return Vec::new() };
            let before = source[..close].trim_end();
            if before.ends_with('{') {
                vec![insert(path, &source, before.len() as u32, &format!("\n    {line}\n"))]
            } else {
                vec![insert(path, &source, before.len() as u32, &format!(",\n    {line}"))]
            }
        }
        None => vec![
            FileEdit::Create { path: path.to_path_buf().into(), overwrite: false },
            insert(path, "", 0, &format!("{{\n    {line}\n}}\n")),
        ],
    }
}

/// The `.php` files below `dir` with their group names (`admin/users`).
fn php_files_below(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            php_files_below(base, &path, out);
        } else if path.extension().is_some_and(|ext| ext == "php")
            && let Ok(rel) = path.strip_prefix(base)
            && let Some(rel) = rel.to_str().and_then(|rel| rel.strip_suffix(".php"))
        {
            out.push((rel.replace('\\', "/"), path.clone()));
        }
    }
}

/// The keys of a JSON translation file, with the ranges of their keys.
fn json_entries(locale: &str, path: &Path, text: &str) -> Vec<TransEntry> {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let lines = LineIndex::new(text);
    let mut out = Vec::new();
    for (key, value) in map {
        let quoted = serde_json::to_string(&key).unwrap_or_default();
        // The key's literal: followed by a `:`.
        let mut from = 0;
        let mut range = Range::default();
        while let Some(at) = text[from..].find(&quoted) {
            let start = from + at;
            let end = start + quoted.len();
            if text[end..].trim_start().starts_with(':') {
                range = lines.range(start as u32 + 1, end as u32 - 1);
                break;
            }
            from = end;
        }
        out.push(TransEntry {
            key,
            locale: locale.to_owned(),
            path: path.to_path_buf(),
            range,
            text: value.as_str().map(str::to_owned),
            is_group: false,
            is_file: false,
            json: true,
        });
    }
    out
}
