//! Vue components used in Blade templates (`<v-dashboard-filters>`), as in
//! Laravel apps that mount Vue on their server-rendered pages: goto from a
//! component tag to where the component is registered,
//! `app.component('v-dashboard-filters', {…})`, in the template itself, in
//! another template or in the app's JavaScript, else to a single-file
//! component named like the tag (`VDashboardFilters.vue`).
//!
//! Vue matches a tag to a registration in kebab or Pascal case
//! (`<v-form>` is `VForm`); names are compared without case, `-` and `_`.
//! Only Vue's public documentation is a design input.

use std::path::{Path, PathBuf};

use parking_lot::Mutex;

use super::BladeDocument;
use crate::engine::PhpEngine;
use crate::navigate::Target;
use crate::project::normalize;
use crate::syntax::LineIndex;

/// A byte span of a template.
pub type Span = (u32, u32);

fn is_tag_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':')
}

/// The name of the custom element whose tag (`<v-foo` or `</v-foo`) the
/// caret at `offset` is on, when it can be a Vue component: kebab case with
/// a `-`, or Pascal case. Blade's own `<x-…>` and `<livewire:…>` tags are
/// not.
pub fn component_tag_at(text: &str, offset: u32) -> Option<Span> {
    let bytes = text.as_bytes();
    let offset = (offset as usize).min(bytes.len());
    let mut start = offset;
    while start > 0 && is_tag_char(bytes[start - 1]) {
        start -= 1;
    }
    let mut end = offset;
    while end < bytes.len() && is_tag_char(bytes[end]) {
        end += 1;
    }
    if start == end {
        return None;
    }
    let opens = match bytes.get(start.checked_sub(1)?)? {
        b'<' => true,
        b'/' => start >= 2 && bytes[start - 2] == b'<',
        _ => false,
    };
    if !opens {
        return None;
    }
    let name = &text[start..end];
    let lower = name.to_ascii_lowercase();
    if lower.starts_with("x-") || lower.starts_with("x:") || name.contains(':') || name.contains('.') {
        return None;
    }
    let kebab = name.contains('-') && name.as_bytes()[0].is_ascii_alphabetic();
    let pascal = name.as_bytes()[0].is_ascii_uppercase();
    (kebab || pascal).then_some((start as u32, end as u32))
}

/// `name` without case, `-` and `_`: `v-form`, `VForm` and `v_form` are equal.
pub fn normalize_name(name: &str) -> String {
    name.chars().filter(|c| *c != '-' && *c != '_').flat_map(char::to_lowercase).collect()
}

/// The spans of the names of the `component('name', …)` registrations of
/// `wanted` (normalized) in `text`.
pub fn registrations(text: &str, wanted: &str) -> Vec<Span> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(found) = text[from..].find("component(") {
        let at = from + found;
        from = at + "component(".len();
        // `.component(` or `component(` at a word start (not `mycomponent(`).
        if at > 0 && (bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_') {
            continue;
        }
        let mut i = from;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let Some(&quote) = bytes.get(i).filter(|q| matches!(q, b'\'' | b'"' | b'`')) else { continue };
        let start = i + 1;
        let Some(len) = text[start..].find(quote as char) else { continue };
        let name = &text[start..start + len];
        if !name.is_empty() && name.len() < 128 && normalize_name(name) == wanted {
            out.push((start as u32, (start + len) as u32));
        }
    }
    out
}

/// The span of the `id` of an `x-template` script named for the component
/// (`id="v-foo-template"`), the template a registration's
/// `template: '#v-foo-template'` points at.
pub fn x_template(text: &str, wanted: &str) -> Option<Span> {
    let mut from = 0;
    while let Some(found) = text[from..].find("id=") {
        let at = from + found + 3;
        from = at;
        let Some(&quote) = text.as_bytes().get(at).filter(|q| matches!(q, b'\'' | b'"')) else { continue };
        let start = at + 1;
        let Some(len) = text[start..].find(quote as char) else { continue };
        let id = &text[start..start + len];
        if let Some(name) = id.strip_suffix("-template")
            && normalize_name(name) == wanted
        {
            return Some((start as u32, (start + len) as u32));
        }
    }
    None
}

/// Folders that hold no source of the app's own.
const SKIPPED: &[&str] = &[".git", "node_modules", "vendor", "storage", "public", "bootstrap", "dist", "build"];
const SCANNED: &[&str] = &["js", "mjs", "cjs", "ts", "vue", "php"];
const MAX_FILE: u64 = 1 << 20;

fn scanned(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if name.ends_with(".php") {
        return name.ends_with(".blade.php");
    }
    path.extension().and_then(|e| e.to_str()).is_some_and(|ext| SCANNED.contains(&ext.to_ascii_lowercase().as_str()))
}

/// The template, script and single-file component files below `root`.
fn source_files(root: &Path) -> Vec<PathBuf> {
    let collected = Mutex::new(Vec::new());
    let mut builder = ignore::WalkBuilder::new(root);
    builder.standard_filters(false).follow_links(false);
    builder.filter_entry(|entry| {
        entry.depth() == 0
            || !entry.file_type().is_some_and(|ft| ft.is_dir())
            || !SKIPPED.contains(&entry.file_name().to_string_lossy().as_ref())
    });
    builder.build_parallel().run(|| {
        Box::new(|result| {
            if let Ok(entry) = result
                && entry.file_type().is_some_and(|ft| ft.is_file())
                && scanned(entry.path())
                && entry.metadata().is_ok_and(|m| m.len() <= MAX_FILE)
            {
                collected.lock().push(entry.into_path());
            }
            ignore::WalkState::Continue
        })
    });
    let mut files = collected.into_inner();
    files.sort();
    files
}

fn targets(path: &Path, text: &str, spans: &[Span]) -> Vec<Target> {
    let lines = LineIndex::new(text);
    spans.iter().map(|&(start, end)| Target { path: normalize(path), range: lines.range(start, end) }).collect()
}

impl PhpEngine {
    /// Goto definition on a Vue component tag of a template: its
    /// registrations, here first, then in the project's templates and
    /// scripts; else its `x-template`, else a `.vue` file named like it.
    /// `None` when the caret is on no such tag or nothing is found.
    pub fn blade_vue_definition(&self, blade: &BladeDocument, offset: u32) -> Option<Vec<Target>> {
        let (start, end) = component_tag_at(blade.text, offset)?;
        let wanted = normalize_name(&blade.text[start as usize..end as usize]);
        let here = registrations(blade.text, &wanted);
        if !here.is_empty() {
            return Some(targets(blade.path, blade.text, &here));
        }
        let own = normalize(blade.path);
        let files: Vec<(PathBuf, String)> = source_files(&self.root())
            .into_iter()
            .filter(|path| normalize(path) != own)
            .filter_map(|path| std::fs::read_to_string(&path).ok().map(|text| (path, text)))
            .collect();
        let found: Vec<Target> =
            files.iter().flat_map(|(path, text)| targets(path, text, &registrations(text, &wanted))).collect();
        if !found.is_empty() {
            return Some(found);
        }
        if let Some(span) = x_template(blade.text, &wanted) {
            return Some(targets(blade.path, blade.text, &[span]));
        }
        if let Some((path, text, span)) =
            files.iter().find_map(|(path, text)| x_template(text, &wanted).map(|span| (path, text, span)))
        {
            return Some(targets(path, text, &[span]));
        }
        let sfc: Vec<Target> = files
            .iter()
            .filter(|(path, _)| {
                path.extension().is_some_and(|e| e.eq_ignore_ascii_case("vue"))
                    && path.file_stem().is_some_and(|stem| normalize_name(&stem.to_string_lossy()) == wanted)
            })
            .map(|(path, _)| Target { path: normalize(path), range: Default::default() })
            .collect();
        (!sfc.is_empty()).then_some(sfc)
    }
}
