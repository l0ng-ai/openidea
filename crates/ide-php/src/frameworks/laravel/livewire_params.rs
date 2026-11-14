//! `BladeUnknownLivewireParameter`: the parameters a Blade template passes
//! to a Livewire component that the component doesn't take, in
//! `@livewire('counter', ['start' => 1])` (the array's keys) and in
//! `<livewire:counter start="1" />` (the attributes, in kebab case). A
//! component takes the parameters of its `mount()` and its public
//! properties ([`PhpEngine::livewire_parameters`]).
//!
//! Not reported: components the project doesn't have (or whose class isn't
//! known), keys that aren't literal strings, and the attributes Livewire
//! or the browser read themselves (`key`, `lazy`, `wire:…`, `x-…`, `@…`,
//! `class`, `id`, `data-…`…).

use std::ops::Range as Span;

use ide_core::{Diagnostic, Severity};

use super::blade::kebab;
use crate::blade::structure::{DIAGNOSTIC_SOURCE, INSPECTIONS};
use crate::blade::tags::{LIVEWIRE_PREFIXES, tag_at_with};
use crate::engine::{EngineState, PhpEngine};
use crate::syntax::LineIndex;

/// The inspection's code.
pub const CODE: &str = INSPECTIONS[3];

/// A parameter passed to a component: its name and where it is written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Passed {
    /// The component's name or class, as written.
    pub component: String,
    /// The key or the attribute's name (without `:`).
    pub name: String,
    pub span: Span<u32>,
    /// From a `<livewire:…>` tag (compared in kebab case).
    pub tag: bool,
}

/// The attributes of a `<livewire:…>` tag Livewire or the browser read.
fn is_reserved_attribute(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    name.contains(':')
        || name.starts_with('@')
        || ["x-", "data-", "aria-", "wire"].iter().any(|prefix| lower.starts_with(prefix))
        || ["key", "lazy", "class", "id", "style", "title"].contains(&lower.as_str())
}

/// The end of the string literal opening at `at` (its closing quote).
fn string_end(b: &[u8], at: usize) -> usize {
    let quote = b[at];
    let mut i = at + 1;
    while i < b.len() && b[i] != quote {
        if b[i] == b'\\' {
            i += 1;
        }
        i += 1;
    }
    i.min(b.len())
}

fn skip_space(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// The literal string keys of the array opening at `open` (its top level).
fn array_keys(text: &str, open: usize) -> Vec<(String, Span<u32>)> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            b'[' | b'(' | b'{' => depth += 1,
            b']' | b')' | b'}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    break;
                }
            }
            b'\'' | b'"' => {
                let end = string_end(b, i);
                let after = skip_space(b, end + 1);
                if depth == 1 && b[after.min(b.len())..].starts_with(b"=>") {
                    out.push((text[i + 1..end].to_owned(), (i + 1) as u32..end as u32));
                }
                i = end;
            }
            _ => {}
        }
        i += 1;
    }
    out
}

/// What the `@livewire(…)` directives and `<livewire:…>` tags of `text`
/// pass.
pub fn passed_parameters(text: &str) -> Vec<Passed> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    // `@livewire('name', [...])`.
    let mut from = 0;
    while let Some(at) = text[from..].find("@livewire(") {
        let open = from + at + "@livewire".len();
        from = open + 1;
        let mut i = skip_space(b, open + 1);
        let component = match b.get(i) {
            Some(b'\'' | b'"') => {
                let end = string_end(b, i);
                let name = text[i + 1..end].to_owned();
                i = end + 1;
                name
            }
            Some(_) => {
                let start = i;
                while i < b.len() && !matches!(b[i], b',' | b')') {
                    i += 1;
                }
                match text[start..i].trim().strip_suffix("::class") {
                    Some(class) => class.trim().to_owned(),
                    None => continue,
                }
            }
            None => break,
        };
        i = skip_space(b, i);
        if b.get(i) != Some(&b',') {
            continue;
        }
        i = skip_space(b, i + 1);
        if b.get(i) != Some(&b'[') {
            continue;
        }
        for (name, span) in array_keys(text, i) {
            out.push(Passed { component: component.clone(), name, span, tag: false });
        }
    }
    // `<livewire:name attr="…" />`.
    let mut from = 0;
    while let Some(at) = text[from..].find("<livewire:") {
        let start = from + at;
        let Some(tag) = tag_at_with(text, start, LIVEWIRE_PREFIXES) else {
            from = start + 1;
            continue;
        };
        from = (tag.end as usize).max(start + 1);
        let component = tag.name(text).to_owned();
        for attribute in &tag.attributes {
            let name = attribute.bare_name(text);
            if name.is_empty() || is_reserved_attribute(name) {
                continue;
            }
            let written = &text[attribute.name.start as usize..attribute.name.end as usize];
            let skip = (written.len() - name.len()) as u32;
            let span = attribute.name.start + skip..attribute.name.end;
            out.push(Passed { component: component.clone(), name: name.to_owned(), span, tag: true });
        }
    }
    out
}

impl PhpEngine {
    /// `BladeUnknownLivewireParameter` (see the module documentation), once
    /// indexing finished.
    pub(crate) fn unknown_livewire_parameters(&self, text: &str) -> Vec<Diagnostic> {
        if self.status().state != EngineState::Ready || !text.contains("livewire") {
            return Vec::new();
        }
        let Some(components) = self.laravel_livewire() else { return Vec::new() };
        let resolver = self.resolver();
        let lines = LineIndex::new(text);
        let mut out = Vec::new();
        for passed in passed_parameters(text) {
            let Some(component) = components.find(&passed.component) else { continue };
            if resolver.class_model(&component.class).is_none() {
                continue;
            }
            let known = if passed.tag {
                let wanted = kebab(&passed.name);
                self.livewire_tag_attributes(component).iter().any(|member| member.name == wanted)
            } else {
                self.livewire_parameters(&component.class).iter().any(|member| member.name == passed.name)
            };
            if known {
                continue;
            }
            out.push(Diagnostic {
                range: lines.range(passed.span.start, passed.span.end),
                severity: Severity::Warning,
                message: format!("Livewire component '{}' has no parameter '{}'", component.name, passed.name),
                source: Some(DIAGNOSTIC_SOURCE.into()),
                code: Some(CODE.into()),
                unnecessary: false,
                deprecated: false,
                server: None,
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_templates_pass() {
        let text = "@livewire('counter', ['start' => 1, \"step\" => ['nested' => 2], $dynamic => 3])\n\
                    @livewire(\\App\\Livewire\\Counter::class, ['start' => 1])\n\
                    @livewire('plain')\n\
                    <livewire:counter :start=\"$n\" :$step wire:key=\"k\" key=\"a\" lazy max-value=\"9\" />";
        let found: Vec<(String, String, bool, &str)> = passed_parameters(text)
            .into_iter()
            .map(|p| {
                let written = &text[p.span.start as usize..p.span.end as usize];
                (p.component, p.name, p.tag, written)
            })
            .collect();
        let expected: Vec<(String, String, bool, &str)> = vec![
            ("counter".into(), "start".into(), false, "start"),
            ("counter".into(), "step".into(), false, "step"),
            ("\\App\\Livewire\\Counter".into(), "start".into(), false, "start"),
            ("counter".into(), "start".into(), true, "start"),
            ("counter".into(), "step".into(), true, "step"),
            ("counter".into(), "max-value".into(), true, "max-value"),
        ];
        assert_eq!(found, expected);
    }
}
