//! Laravel views and Blade components ⇄ files, and goto definition from the
//! names a template uses.
//!
//! A view name is a dotted path below `resources/views` (`layouts.app` is
//! `resources/views/layouts/app.blade.php`, else `….php`). A component tag
//! `<x-forms.input-group>` is the class `App\View\Components\Forms\InputGroup`
//! (`app/View/Components/Forms/InputGroup.php`) and/or the view
//! `components.forms.input-group` (also `…/input-group/index.blade.php` and
//! `…/input-group/input-group.blade.php` for anonymous components), as
//! Laravel's `ComponentTagCompiler` looks them up. Namespaced names
//! (`package::view`, `<x-package::alert>`) aren't resolved.

use std::ops::Range as Span;
use std::path::{Component, Path, PathBuf};

use ide_core::{Pos, Range};

use super::{NodeKind, parse, string_args};
use crate::syntax::LineIndex;

/// The directives whose string arguments name views.
const VIEW_DIRECTIVES: &[&str] = &[
    "component",
    "componentFirst",
    "each",
    "extends",
    "extendsFirst",
    "include",
    "includeFirst",
    "includeIf",
    "includeUnless",
    "includeWhen",
];

/// Where a Laravel project's views and components live.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewPaths {
    root: PathBuf,
    views: PathBuf,
}

impl ViewPaths {
    /// The views of the project at `root` (`resources/views`).
    pub fn new(root: &Path) -> Self {
        Self { root: root.to_path_buf(), views: root.join("resources").join("views") }
    }

    /// Whether `path` is a component view (below `views/components`).
    pub fn is_component_view(&self, path: &Path) -> bool {
        path.starts_with(self.views.join("components"))
            || path.to_string_lossy().replace('\\', "/").contains("/views/components/")
    }

    /// The file of view `name` (`layouts.app`), if it exists.
    pub fn view(&self, name: &str) -> Option<PathBuf> {
        let relative = relative(name)?;
        ["blade.php", "php"]
            .iter()
            .map(|ext| self.views.join(format!("{}.{ext}", relative.display())))
            .find(|file| file.is_file())
    }

    /// The files of component `name` (`alert`, `forms.input`): its class,
    /// then its view, those that exist.
    pub fn component(&self, name: &str) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let Some(relative) = relative(name) else { return found };
        let class: PathBuf = relative.components().map(|part| studly(&part.as_os_str().to_string_lossy())).collect();
        let class = self.root.join("app/View/Components").join(class).with_extension("php");
        if class.is_file() {
            found.push(class);
        }
        let last = relative.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let components = self.views.join("components");
        let views = [
            components.join(format!("{}.blade.php", relative.display())),
            components.join(&relative).join("index.blade.php"),
            components.join(&relative).join(format!("{last}.blade.php")),
            components.join(format!("{}.php", relative.display())),
        ];
        found.extend(views.into_iter().find(|file| file.is_file()));
        found
    }
}

/// `a.b-c` → `a/b-c`; `None` for namespaced or malformed names.
fn relative(name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.contains("::") {
        return None;
    }
    let path = PathBuf::from(name.replace('.', "/"));
    path.components().all(|c| matches!(c, Component::Normal(_))).then_some(path)
}

/// `input-group` → `InputGroup`.
fn studly(kebab: &str) -> String {
    kebab
        .split(['-', '_'])
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map(|c| c.to_uppercase().chain(chars).collect::<String>()).unwrap_or_default()
        })
        .collect()
}

/// A name a template refers to at a position.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ViewRef {
    /// A string argument of `@include`, `@extends` and the like.
    View(String),
    /// The name of an `<x-…>` (or `</x-…>`) tag.
    Component(String),
}

/// The view or component name at `pos` of a template, with its range.
pub fn view_ref_at(text: &str, pos: Pos) -> Option<(ViewRef, Range)> {
    let lines = LineIndex::new(text);
    let offset = lines.byte(pos);
    for node in parse(text) {
        if let (NodeKind::Directive { name }, Some(code)) = (&node.kind, &node.code)
            && VIEW_DIRECTIVES.contains(&name.as_str())
            && code.start <= offset
            && offset <= code.end
        {
            return string_args(text, code)
                .into_iter()
                .find(|(_, span)| span.start <= offset && offset <= span.end)
                .map(|(name, span)| (ViewRef::View(name), lines.range(span.start, span.end)));
        }
    }
    let (name, span) = component_tag_at(text, offset)?;
    Some((ViewRef::Component(name), lines.range(span.start, span.end)))
}

/// The component name of the `<x-name` or `</x-name` tag under `offset`.
fn component_tag_at(text: &str, offset: u32) -> Option<(String, Span<u32>)> {
    let b = text.as_bytes();
    let offset = (offset as usize).min(b.len());
    let is_name = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'.' | b'_' | b':');
    let start = (0..offset).rev().find(|&at| !is_name(b[at])).map_or(0, |at| at + 1);
    let end = (offset..b.len()).find(|&at| !is_name(b[at])).unwrap_or(b.len());
    let word = &text[start..end];
    let name = word.strip_prefix("x-")?;
    let opened = start >= 1 && b[start - 1] == b'<' || start >= 2 && &b[start - 2..start] == b"</";
    if !opened || name.is_empty() || name.starts_with("slot") || name == "dynamic-component" || name.contains("::") {
        return None;
    }
    let name_start = (start + 2) as u32;
    Some((name.to_owned(), name_start..end as u32))
}

/// Goto definition of the view or component name at `pos`.
pub fn goto_view(text: &str, pos: Pos, paths: &ViewPaths) -> Vec<PathBuf> {
    match view_ref_at(text, pos) {
        Some((ViewRef::View(name), _)) => paths.view(&name).into_iter().collect(),
        Some((ViewRef::Component(name), _)) => paths.component(&name),
        None => Vec::new(),
    }
}
