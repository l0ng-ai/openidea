//! Reading Zig's own text formats for External Libraries, without running Zig:
//! the package manifest (`build.zig.zon`) and the `zig env` output. Both are
//! Zig struct literals; `zig env` printed JSON before Zig 0.15.

use serde::Deserialize;
use std::path::{Path, PathBuf};

/// One `.dependencies` entry of a `build.zig.zon`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ZonDependency {
    pub name: String,
    /// Package hash: its sources are fetched into the global cache as `p/<hash>`
    /// (Zig ≤ 0.14 unpacks them, Zig ≥ 0.15 keeps `p/<hash>.tar.gz` blobs).
    pub hash: Option<String>,
    /// A path dependency, part of the project tree rather than the package cache.
    pub path: Option<String>,
    /// Fetched only when the build actually references it.
    pub lazy: bool,
}

/// The `.dependencies` entries of a `build.zig.zon`, in order. Tolerant of
/// partially edited files: whatever does not parse is skipped.
pub(crate) fn zon_dependencies(zon: &str) -> Vec<ZonDependency> {
    let src = code_only(zon);
    let Some(top) = struct_body(&src) else { return Vec::new() };
    let Some((_, value)) = fields(top).into_iter().find(|(name, _)| *name == "dependencies") else {
        return Vec::new();
    };
    let Some(deps) = struct_body(value) else { return Vec::new() };
    fields(deps)
        .into_iter()
        .map(|(name, value)| {
            let entry = struct_body(value).map(|body| fields(body)).unwrap_or_default();
            ZonDependency {
                name: name.to_owned(),
                hash: field(&entry, "hash"),
                path: field(&entry, "path"),
                lazy: entry.iter().any(|(n, v)| *n == "lazy" && v.trim() == "true"),
            }
        })
        .collect()
}

/// A top-level string (or enum-literal, `.name`) field of a Zig struct literal.
pub(crate) fn zon_string_field(text: &str, name: &str) -> Option<String> {
    let src = code_only(text);
    let top = struct_body(&src)?;
    field(&fields(top), name)
}

/// What `zig env` reports that External Libraries needs.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct ZigEnv {
    pub zig_exe: Option<PathBuf>,
    pub lib_dir: Option<PathBuf>,
    pub std_dir: Option<PathBuf>,
    pub global_cache_dir: Option<PathBuf>,
    pub version: Option<String>,
}

impl ZigEnv {
    /// The standard library sources: `std_dir`, else `lib_dir/std`. A relative
    /// path resolves against the zig install dir (stage builds print relative paths).
    pub(crate) fn std_sources(&self) -> Option<PathBuf> {
        let resolve = |p: &Path| match (p.is_relative(), self.zig_exe.as_ref().and_then(|e| e.parent())) {
            (true, Some(install)) => install.join(p),
            _ => p.to_path_buf(),
        };
        self.std_dir
            .as_deref()
            .map(Path::new)
            .map(resolve)
            .or_else(|| self.lib_dir.as_deref().map(Path::new).map(|dir| resolve(dir).join("std")))
    }
}

/// The `zig env` output: JSON (older Zig) or a struct literal (Zig ≥ 0.15).
pub(crate) fn parse_zig_env(out: &str) -> Option<ZigEnv> {
    #[derive(Deserialize)]
    struct Json {
        zig_exe: Option<PathBuf>,
        lib_dir: Option<PathBuf>,
        std_dir: Option<PathBuf>,
        global_cache_dir: Option<PathBuf>,
        version: Option<String>,
    }
    if let Ok(json) = serde_json::from_str::<Json>(out.trim()) {
        return Some(ZigEnv {
            zig_exe: json.zig_exe,
            lib_dir: json.lib_dir,
            std_dir: json.std_dir,
            global_cache_dir: json.global_cache_dir,
            version: json.version,
        });
    }
    let src = code_only(out);
    let top = struct_body(&src)?;
    let f = fields(top);
    Some(ZigEnv {
        zig_exe: field(&f, "zig_exe").map(PathBuf::from),
        lib_dir: field(&f, "lib_dir").map(PathBuf::from),
        std_dir: field(&f, "std_dir").map(PathBuf::from),
        global_cache_dir: field(&f, "global_cache_dir").map(PathBuf::from),
        version: field(&f, "version"),
    })
}

/// The string (or enum-literal, `.foo`) value of a field of a struct body.
fn field<'a>(entry: &[(&'a str, &'a str)], name: &str) -> Option<String> {
    let value = entry.iter().find(|(n, _)| *n == name)?.1;
    if let Some(string) = string_value(value) {
        return Some(string);
    }
    value
        .strip_prefix('.')
        .filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_'))
        .map(str::to_owned)
}

/// The contents of the string literal starting at `value`, `\"` unescaped.
fn string_value(value: &str) -> Option<String> {
    let rest = value.trim_start().strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => out.push(chars.next()?),
            c => out.push(c),
        }
    }
    None
}

/// `src` with comments blanked out and string contents kept.
fn code_only(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    for line in src.lines() {
        let bytes = line.as_bytes();
        let mut in_string = false;
        let mut escaped = false;
        let mut end = line.len();
        for (i, &b) in bytes.iter().enumerate() {
            if in_string {
                match b {
                    _ if escaped => escaped = false,
                    b'\\' => escaped = true,
                    b'"' => in_string = false,
                    _ => {}
                }
            } else if b == b'"' {
                in_string = true;
            } else if b == b'/' && bytes.get(i + 1) == Some(&b'/') {
                end = i;
                break;
            }
        }
        out.push_str(&line[..end]);
        out.push('\n');
    }
    out
}

/// The inside of the first `{ … }` of `text`, strings respected.
fn struct_body(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut start = 0;
    while start < bytes.len() {
        match bytes[start] {
            b'"' => start = skip_string(text, start),
            b'{' => break,
            _ => start += 1,
        }
    }
    let mut depth = 0;
    let mut i = start;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => i = skip_string(text, i),
            b'{' => {
                depth += 1;
                i += 1;
            }
            b'}' => {
                if depth == 1 {
                    return Some(&text[start + 1..i]);
                }
                depth -= 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    None
}

/// The index just past the string literal starting at `i` (an opening `"`).
fn skip_string(text: &str, i: usize) -> usize {
    let bytes = text.as_bytes();
    let mut i = i + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => return i + 1,
            _ => i += 1,
        }
    }
    i
}

/// The `.name = value` fields of a struct literal body, in order: `name` is the
/// identifier (or `@"…"` unquoted), `value` trimmed and may itself be `.{ … }`.
fn fields(body: &str) -> Vec<(&str, &str)> {
    let bytes = body.as_bytes();
    let mut out = Vec::new();
    let mut depth = 0;
    let mut field: Option<usize> = None;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => i = skip_string(body, i),
            b'{' | b'[' | b'(' => {
                depth += 1;
                i += 1;
            }
            b'}' | b']' | b')' => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
                i += 1;
            }
            b',' if depth == 0 => {
                if let Some(start) = field.take() {
                    push_field(&mut out, body, start, i);
                }
                i += 1;
            }
            b'.' if depth == 0 && field.is_none() => {
                if bytes.get(i + 1).is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'@') {
                    field = Some(i + 1);
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    if let Some(start) = field {
        push_field(&mut out, body, start, bytes.len());
    }
    out
}

fn push_field<'a>(out: &mut Vec<(&'a str, &'a str)>, body: &'a str, start: usize, end: usize) {
    let text = &body[start..end];
    let Some(eq) = text.find('=') else { return };
    let name = text[..eq].trim().trim_start_matches('@').trim_matches('"');
    if !name.is_empty() {
        out.push((name, text[eq + 1..].trim()));
    }
}
