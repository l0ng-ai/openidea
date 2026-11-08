//! The configuration keys of a Laravel project ([`ConfigKeys`]): the
//! dotted keys of the arrays the files of `config/` return, as Laravel's
//! `LoadConfiguration` bootstrapper names them (`config/app.php` holds
//! `app.*`, `config/services/mail.php` holds `services.mail.*`), each with
//! the place declaring it and the source text of its value.
//!
//! Only string keys of array literals count; a value that isn't an array
//! literal (`env(…)`, a function call) ends the nesting.
//!
//! Packages add configuration of their own ([`package_configs`]): the
//! framework's defaults (`vendor/laravel/framework/config/*.php`, which
//! Laravel 11 merges below the application's files) and the files service
//! providers merge with `mergeConfigFrom(path, 'key')` (the app's and
//! modules' providers, and the providers packages list under
//! `extra.laravel.providers` in `vendor/composer/installed.json`). The
//! application's own keys win.
//!
//! Each value gets a type read from its source ([`value_type`]): literals,
//! casts and `env('…', default)` (the default's type).

use std::path::{Path, PathBuf};

use ide_core::Range;
use mago_span::HasSpan;
use mago_syntax::cst::{ArrayElement, Expression, Literal, Statement};

use super::LaravelProject;
use super::views::{call_arguments, clean, path_expression, php_files, provider_files, string_literal};
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
    /// The value's type when its source says it (`string`, `int`, `bool`,
    /// `array`, …).
    pub ty: Option<String>,
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
        Self::read_with(dir, &[], text_of)
    }

    /// [`read`](Self::read), plus the files of `packages` (`(key, file)`)
    /// below the application's keys.
    pub fn read_with(dir: &Path, packages: &[(String, PathBuf)], text_of: impl Fn(&Path) -> Option<String>) -> Self {
        let mut files = Vec::new();
        config_files(dir, dir, &mut files);
        files.sort();
        files.extend(packages.iter().cloned());
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
            ty: Some("array".to_owned()),
            is_array: true,
            is_file: true,
        }];
        if let Some(array) = returned_array(parsed) {
            collect(parsed, path, prefix, array, &mut out);
        }
        out
    }

    /// The entries sorted by key; of entries with one key, the first wins.
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
        let span = element.value.span();
        let source = parsed.text().get(span.start.offset as usize..span.end.offset as usize).unwrap_or_default();
        out.push(ConfigEntry {
            key: key.clone(),
            path: path.to_path_buf(),
            range: lines.range(start, end),
            value,
            ty: value_type(source),
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

/// The type of a value written `source`, when the source says it: a
/// literal, a cast, an array, or `env('…', default)` (the default's type).
pub fn value_type(source: &str) -> Option<String> {
    let source = source.trim();
    let lower = source.to_ascii_lowercase();
    let compact = lower.replace([' ', '\t'], "");
    let casts: [(&[&str], &str); 5] = [
        (&["(int)", "(integer)"], "int"),
        (&["(bool)", "(boolean)"], "bool"),
        (&["(string)"], "string"),
        (&["(float)", "(double)"], "float"),
        (&["(array)"], "array"),
    ];
    for (names, ty) in casts {
        if names.iter().any(|cast| compact.starts_with(cast)) {
            return Some(ty.to_owned());
        }
    }
    let ty = match lower.as_str() {
        "true" | "false" => "bool",
        "null" => "null",
        _ if source.starts_with(['\'', '"']) => "string",
        _ if source.starts_with('[') || compact.starts_with("array(") => "array",
        _ if source.replace('_', "").parse::<i64>().is_ok() => "int",
        _ if source.parse::<f64>().is_ok() => "float",
        _ if compact.trim_start_matches('\\').starts_with("env(") => {
            let open = source.find('(')?;
            let args = call_arguments(source, open)?;
            return match args.get(1) {
                Some(default) => value_type(default),
                None => Some("mixed".to_owned()),
            };
        }
        _ => return None,
    };
    Some(ty.to_owned())
}

/// The configuration files packages add, as `(key, file)`; see the module
/// documentation. `text_of` reads a provider.
pub fn package_configs(project: &LaravelProject, text_of: impl Fn(&Path) -> Option<String>) -> Vec<(String, PathBuf)> {
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    let framework = project.root.join("vendor").join("laravel").join("framework").join("config");
    for path in php_files(&framework) {
        if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
            out.push((stem.to_owned(), crate::project::normalize(&path)));
        }
    }
    let mut providers = provider_files(project);
    providers.extend(vendor_providers(&project.root));
    for provider in providers {
        let Some(text) = text_of(&provider) else { continue };
        let call = "mergeConfigFrom(";
        let mut from = 0;
        while let Some(at) = text[from..].find(call) {
            let open = from + at + call.len() - 1;
            from = open + 1;
            let Some(args) = call_arguments(&text, open) else { continue };
            let (Some(file), Some(key)) = (args.first(), args.get(1)) else { continue };
            let Some(key) = string_literal(key) else { continue };
            let Some(file) = path_expression(project, &provider, file) else { continue };
            if !out.iter().any(|(known, path)| *known == key && *path == file) {
                out.push((key, file));
            }
        }
    }
    out
}

/// The service provider files installed packages list under
/// `extra.laravel.providers`, found through their PSR-4 autoload.
fn vendor_providers(root: &Path) -> Vec<PathBuf> {
    let composer = root.join("vendor").join("composer");
    let Ok(text) = std::fs::read_to_string(composer.join("installed.json")) else { return Vec::new() };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { return Vec::new() };
    let packages = json.get("packages").unwrap_or(&json).as_array().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for package in packages {
        let Some(providers) = package.pointer("/extra/laravel/providers").and_then(|p| p.as_array()) else {
            continue;
        };
        let install = package.get("install-path").and_then(|p| p.as_str());
        let dir = match (install, package.get("name").and_then(|n| n.as_str())) {
            (Some(install), _) => composer.join(install),
            (None, Some(name)) => root.join("vendor").join(name),
            _ => continue,
        };
        let psr4 = package.pointer("/autoload/psr-4").and_then(|p| p.as_object()).cloned().unwrap_or_default();
        for provider in providers.iter().filter_map(|p| p.as_str()) {
            let provider = provider.trim_start_matches('\\');
            for (prefix, dirs) in &psr4 {
                let Some(rest) = provider.strip_prefix(prefix.as_str()) else { continue };
                let dirs: Vec<&str> = match dirs {
                    serde_json::Value::String(one) => vec![one.as_str()],
                    serde_json::Value::Array(many) => many.iter().filter_map(|d| d.as_str()).collect(),
                    _ => Vec::new(),
                };
                for base in dirs {
                    let file = dir.join(base).join(format!("{}.php", rest.replace('\\', "/")));
                    if file.is_file() {
                        out.push(crate::project::normalize(&clean(&file)));
                    }
                }
            }
        }
    }
    out
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
