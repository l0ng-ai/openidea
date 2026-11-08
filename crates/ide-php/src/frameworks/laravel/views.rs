//! The views of a Laravel project ([`ViewTable`]) and the variables passed
//! to them ([`passed_variables`]).
//!
//! - **Views:** the files below `resources/views` (`posts/index.blade.php`
//!   is `posts.index`; a `.blade.php` file wins over a `.php` one), as
//!   Laravel's `FileViewFinder` finds them.
//! - **Namespaces** (`billing::invoices.index`): a module's
//!   `resources/views` (or `Resources/views`) under the module's lower-case
//!   name, as `nwidart/laravel-modules` registers it, and the
//!   `loadViewsFrom(path, 'ns')` and `View::addNamespace('ns', path)` calls of
//!   the service providers of the app and of the modules, whose path is made
//!   of `__DIR__`, `dirname(__DIR__)`, string literals, `base_path()`,
//!   `resource_path()`, `app_path()` and `module_path()`.
//! - **Data:** the variables a call passes to a view: the array after the
//!   view's name (`view('x', ['user' => $u])`, `@include('x', [...])`), a
//!   `compact('a', 'b')` there, and `->with('k', $v)` / `->with([...])` chained
//!   on the call, each with its type at the call.
//!
//! Only Laravel's documentation and source (MIT) are design inputs.

use std::path::{Component, Path, PathBuf};

use mago_span::HasSpan;
use mago_syntax::cst::{Argument, ArgumentList, ArrayElement, Call, ClassLikeMemberSelector, Expression, Literal};
use mago_syntax::walker::Walker;

use super::LaravelProject;
use crate::project::normalize;
use crate::syntax::ParsedFile;
use crate::types::{ExprTypes, Type};

/// See the module documentation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ViewTable {
    /// Sorted by name.
    views: Vec<ViewEntry>,
    /// Sorted by name.
    namespaces: Vec<ViewNamespace>,
    /// The application's views folder.
    dir: PathBuf,
}

/// One view.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewEntry {
    /// The full name (`posts.index`, `billing::invoices.index`).
    pub name: String,
    pub path: PathBuf,
    /// The folder the name is relative to.
    pub base: PathBuf,
}

impl ViewEntry {
    /// The namespace, when the name has one.
    pub fn namespace(&self) -> Option<&str> {
        self.name.split_once("::").map(|(namespace, _)| namespace)
    }

    /// The name without its namespace.
    pub fn local(&self) -> &str {
        self.name.split_once("::").map_or(&self.name, |(_, local)| local)
    }

    /// The file's extension: `blade.php` or `php`.
    pub fn extension(&self) -> &'static str {
        if is_blade(&self.path) { "blade.php" } else { "php" }
    }
}

/// A view namespace and its folders.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewNamespace {
    pub name: String,
    pub dirs: Vec<PathBuf>,
}

/// A segment below a folder of views, for completion.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewChild {
    pub segment: String,
    /// The view the segment ends, else a folder.
    pub view: Option<PathBuf>,
}

/// Whether `path` is a Blade template.
pub fn is_blade(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name.to_string_lossy().to_ascii_lowercase().ends_with(".blade.php"))
}

/// A view name as Laravel normalizes it (`posts/index` is `posts.index`).
pub fn normalize_name(name: &str) -> String {
    match name.split_once("::") {
        Some((namespace, local)) => format!("{namespace}::{}", local.replace('/', ".")),
        None => name.replace('/', "."),
    }
}

impl ViewTable {
    /// The views of `project`; `text_of` reads a service provider (an open
    /// buffer first).
    pub fn read(project: &LaravelProject, text_of: impl Fn(&Path) -> Option<String>) -> Self {
        let mut namespaces: Vec<ViewNamespace> = Vec::new();
        let mut add = |name: String, dir: PathBuf| {
            if !dir.is_dir() {
                return;
            }
            let dir = normalize(&dir);
            match namespaces.iter_mut().find(|known| known.name == name) {
                Some(known) if !known.dirs.contains(&dir) => known.dirs.push(dir),
                Some(_) => {}
                None => namespaces.push(ViewNamespace { name, dirs: vec![dir] }),
            }
        };
        for module in project.modules.iter().filter(|module| module.enabled) {
            for sub in ["resources/views", "Resources/views", "Resources/Views"] {
                let dir = module.path.join(sub);
                if dir.is_dir() {
                    add(module.name.to_ascii_lowercase(), dir);
                    break;
                }
            }
        }
        let mut providers: Vec<PathBuf> = php_files(&project.paths.app.join("Providers"));
        for module in &project.modules {
            for sub in ["Providers", "app/Providers", "src/Providers"] {
                providers.extend(php_files(&module.path.join(sub)));
            }
        }
        for path in providers {
            let Some(text) = text_of(&path) else { continue };
            for (name, dir) in registered_namespaces(project, &path, &text) {
                add(name, dir);
            }
        }
        namespaces.sort_by(|a, b| a.name.cmp(&b.name));

        let dir = project.paths.views.clone();
        let mut views = Vec::new();
        collect_views(&dir, &dir, None, &mut views);
        for namespace in &namespaces {
            for base in &namespace.dirs {
                collect_views(base, base, Some(&namespace.name), &mut views);
            }
        }
        // A `.blade.php` file wins over a `.php` one; the first folder of a
        // namespace wins over the next.
        views.sort_by(|a: &ViewEntry, b: &ViewEntry| {
            a.name.cmp(&b.name).then_with(|| is_blade(&b.path).cmp(&is_blade(&a.path)))
        });
        views.dedup_by(|later, first| later.name == first.name);
        Self { views, namespaces, dir }
    }

    /// Every view, sorted by name.
    pub fn views(&self) -> &[ViewEntry] {
        &self.views
    }

    pub fn is_empty(&self) -> bool {
        self.views.is_empty()
    }

    /// The view named `name` (`posts/index` too).
    pub fn get(&self, name: &str) -> Option<&ViewEntry> {
        let name = normalize_name(name);
        self.views.binary_search_by(|view| view.name.as_str().cmp(&name)).ok().map(|at| &self.views[at])
    }

    /// The registered namespace `name`.
    pub fn namespace(&self, name: &str) -> Option<&ViewNamespace> {
        self.namespaces.iter().find(|namespace| namespace.name == name)
    }

    pub fn namespaces(&self) -> &[ViewNamespace] {
        &self.namespaces
    }

    /// The name of the view file `path`.
    pub fn name_of(&self, path: &Path) -> Option<String> {
        let path = normalize(path);
        self.views.iter().find(|view| view.path == path).map(|view| view.name.clone())
    }

    /// The segments below `parent` (a dotted folder, `None` for the top) of
    /// the views of `namespace` (`None`: the application's), sorted.
    pub fn children(&self, namespace: Option<&str>, parent: Option<&str>) -> Vec<ViewChild> {
        let mut out: Vec<ViewChild> = Vec::new();
        for view in &self.views {
            if view.namespace() != namespace {
                continue;
            }
            let rest = match parent {
                Some(parent) => match view.local().strip_prefix(parent).and_then(|rest| rest.strip_prefix('.')) {
                    Some(rest) => rest,
                    None => continue,
                },
                None => view.local(),
            };
            let child = match rest.split_once('.') {
                Some((folder, _)) => ViewChild { segment: folder.to_owned(), view: None },
                None => ViewChild { segment: rest.to_owned(), view: Some(view.path.clone()) },
            };
            if !out.contains(&child) {
                out.push(child);
            }
        }
        out
    }

    /// The file a new view named `name` goes to (a Blade template): below
    /// the views folder, or the first folder of its namespace. `None` for
    /// an unknown namespace or a malformed name.
    pub fn new_path(&self, name: &str) -> Option<PathBuf> {
        let name = normalize_name(name);
        let (base, local) = match name.split_once("::") {
            Some((namespace, local)) => (self.namespace(namespace)?.dirs.first()?.clone(), local.to_owned()),
            None => (self.dir.clone(), name),
        };
        relative_file(&base, &local, "blade.php")
    }
}

/// `base/a/b.ext` for `a.b`; `None` for a malformed name.
pub fn relative_file(base: &Path, local: &str, extension: &str) -> Option<PathBuf> {
    if !valid_local_name(local) {
        return None;
    }
    let mut path = base.to_path_buf();
    let mut segments = local.split('.').peekable();
    while let Some(segment) = segments.next() {
        if segments.peek().is_some() {
            path.push(segment);
        } else {
            path.push(format!("{segment}.{extension}"));
        }
    }
    Some(path)
}

/// A dotted name of non-empty segments without path or quote characters.
pub fn valid_local_name(local: &str) -> bool {
    !local.is_empty()
        && local.split('.').all(|segment| {
            !segment.is_empty()
                && segment != ".."
                && !segment.contains(['/', '\\', ':', '\'', '"', '*', '?', '<', '>', '|', '$', '{', '}'])
        })
}

/// The `.php` files directly in `dir`, sorted.
fn php_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("php")))
        .collect();
    out.sort();
    out
}

fn collect_views(base: &Path, dir: &Path, namespace: Option<&str>, out: &mut Vec<ViewEntry>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            collect_views(base, &path, namespace, out);
            continue;
        }
        let lower = name.to_ascii_lowercase();
        let stem_len = if lower.ends_with(".blade.php") {
            name.len() - ".blade.php".len()
        } else if lower.ends_with(".php") {
            name.len() - ".php".len()
        } else {
            continue;
        };
        let Ok(relative) = path.parent().unwrap_or(base).strip_prefix(base) else { continue };
        let mut local: Vec<String> =
            relative.components().map(|part| part.as_os_str().to_string_lossy().into_owned()).collect();
        local.push(name[..stem_len].to_owned());
        let local = local.join(".");
        if local.is_empty() {
            continue;
        }
        let name = match namespace {
            Some(namespace) => format!("{namespace}::{local}"),
            None => local,
        };
        out.push(ViewEntry { name, path: normalize(&path), base: normalize(base) });
    }
}

// ------------------------------------------------------- registrations

/// The `(namespace, folder)` pairs the provider `path` registers.
fn registered_namespaces(project: &LaravelProject, path: &Path, text: &str) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    for (call, namespace_first) in [("loadViewsFrom(", false), ("addNamespace(", true)] {
        let mut from = 0;
        while let Some(at) = text[from..].find(call) {
            let open = from + at + call.len() - 1;
            from = open + 1;
            let Some(args) = call_arguments(text, open) else { continue };
            if args.len() < 2 {
                continue;
            }
            let (namespace, dir) = if namespace_first { (&args[0], &args[1]) } else { (&args[1], &args[0]) };
            let Some(namespace) = string_literal(namespace) else { continue };
            let Some(dir) = path_expression(project, path, dir) else { continue };
            out.push((namespace, dir));
        }
    }
    out
}

/// The top-level arguments of the call whose `(` is at `open`, trimmed.
fn call_arguments(text: &str, open: usize) -> Option<Vec<String>> {
    let b = text.as_bytes();
    let mut depth = 0usize;
    let mut args = Vec::new();
    let mut start = open + 1;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            b'(' | b'[' => depth += 1,
            b')' | b']' => {
                depth -= 1;
                if depth == 0 {
                    args.push(text[start..i].trim().to_owned());
                    return Some(args.into_iter().filter(|arg| !arg.is_empty()).collect());
                }
            }
            b',' if depth == 1 => {
                args.push(text[start..i].trim().to_owned());
                start = i + 1;
            }
            quote @ (b'\'' | b'"') => {
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

/// The content of a quoted string without interpolation.
fn string_literal(text: &str) -> Option<String> {
    let text = text.trim();
    let quote = text.chars().next().filter(|c| *c == '\'' || *c == '"')?;
    let inner = text.strip_prefix(quote)?.strip_suffix(quote)?;
    (!inner.contains(quote) && !(quote == '"' && inner.contains('$'))).then(|| inner.to_owned())
}

/// The parts of a `.` concatenation, outside strings and parentheses.
fn concatenation(text: &str) -> Vec<&str> {
    let b = text.as_bytes();
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut start = 0;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'(' => depth += 1,
            b')' => depth = depth.saturating_sub(1),
            b'.' if depth == 0 => {
                parts.push(text[start..i].trim());
                start = i + 1;
            }
            quote @ (b'\'' | b'"') => {
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
    parts.push(text[start..].trim());
    parts
}

/// The folder a path expression of the provider `file` names.
fn path_expression(project: &LaravelProject, file: &Path, text: &str) -> Option<PathBuf> {
    let text = path_expression_text(project, file, text)?;
    Some(normalize(&clean(Path::new(&text))))
}

fn path_part(project: &LaravelProject, file: &Path, part: &str) -> Option<String> {
    let dir = file.parent()?;
    if part == "__DIR__" {
        return Some(dir.to_string_lossy().into_owned());
    }
    if let Some(value) = string_literal(part) {
        return Some(value);
    }
    let (function, _) = part.split_once('(')?;
    let args = call_arguments(part, function.len())?;
    let joined = |base: &Path, rest: Option<&String>| -> Option<String> {
        let rest = match rest {
            Some(rest) => path_expression_text(project, file, rest)?,
            None => String::new(),
        };
        Some(format!("{}/{}", base.to_string_lossy(), rest.trim_start_matches(['/', '\\'])))
    };
    match function.trim().trim_start_matches('\\') {
        "dirname" => {
            let levels: usize = args.get(1).map_or(Some(1), |levels| levels.parse().ok())?;
            let mut base = PathBuf::from(path_expression_text(project, file, args.first()?)?);
            for _ in 0..levels {
                base = base.parent()?.to_path_buf();
            }
            Some(base.to_string_lossy().into_owned())
        }
        "base_path" => joined(&project.root, args.first()),
        "resource_path" => joined(&project.paths.resources, args.first()),
        "app_path" => joined(&project.paths.app, args.first()),
        "module_path" => {
            let module = match args.first().and_then(|name| string_literal(name)) {
                Some(name) => project.module(&name),
                None => project.module_of(file),
            }?;
            joined(&module.path, args.get(1))
        }
        _ => None,
    }
}

fn path_expression_text(project: &LaravelProject, file: &Path, text: &str) -> Option<String> {
    let mut out = String::new();
    for part in concatenation(text) {
        out.push_str(&path_part(project, file, part)?);
    }
    Some(out)
}

/// `a/./b/../c` is `a/c`.
fn clean(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

// ---------------------------------------------------------------- data

/// The call-like expressions of a file, and the `with` calls.
struct Calls<'a> {
    calls: Vec<&'a Expression<'a>>,
}

struct CallWalker;

impl<'a> Walker<'a, 'a, Calls<'a>> for CallWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut Calls<'a>) {
        if matches!(expr, Expression::Call(_) | Expression::Instantiation(_)) {
            cx.calls.push(expr);
        }
    }
}

fn arguments<'a>(expr: &'a Expression<'a>) -> Option<&'a ArgumentList<'a>> {
    match expr {
        Expression::Call(Call::Function(call)) => Some(&call.argument_list),
        Expression::Call(Call::Method(call)) => Some(&call.argument_list),
        Expression::Call(Call::NullSafeMethod(call)) => Some(&call.argument_list),
        Expression::Call(Call::StaticMethod(call)) => Some(&call.argument_list),
        Expression::Instantiation(instantiation) => instantiation.argument_list.as_ref(),
        _ => None,
    }
}

/// `with` called on `object`: `$object->with(…)`.
fn with_object<'a>(expr: &'a Expression<'a>) -> Option<(&'a Expression<'a>, &'a ArgumentList<'a>)> {
    let (object, method, list) = match expr {
        Expression::Call(Call::Method(call)) => (call.object, &call.method, &call.argument_list),
        Expression::Call(Call::NullSafeMethod(call)) => (call.object, &call.method, &call.argument_list),
        _ => return None,
    };
    let ClassLikeMemberSelector::Identifier(name) = method else { return None };
    name.value.eq_ignore_ascii_case(b"with").then_some((object, list))
}

fn function_name(expr: &Expression<'_>) -> Option<String> {
    let Expression::Call(Call::Function(call)) = expr else { return None };
    let Expression::Identifier(identifier) = call.function else { return None };
    let name = String::from_utf8_lossy(identifier.value()).into_owned();
    Some(name.rsplit('\\').next().unwrap_or(&name).to_ascii_lowercase())
}

fn literal_string(expr: &Expression<'_>) -> Option<String> {
    match expr {
        Expression::Literal(Literal::String(string)) => {
            string.value.map(|value| String::from_utf8_lossy(value).into_owned())
        }
        _ => None,
    }
}

/// The variables (`(name, type)`, in order, repeated per call) that the calls
/// naming a view with the string literals whose content starts at `starts`
/// pass to it.
pub fn passed_variables(types: &ExprTypes<'_, '_>, parsed: &ParsedFile, starts: &[u32]) -> Vec<(String, Type)> {
    let mut calls = Calls { calls: Vec::new() };
    CallWalker.walk_program(parsed.program(), &mut calls);
    let mut out = Vec::new();
    for &start in starts {
        let quote = start.saturating_sub(1);
        // The innermost call with an argument holding the string.
        let found = calls
            .calls
            .iter()
            .filter_map(|call| {
                let list = arguments(call)?;
                let (index, _) = list.arguments.iter().enumerate().find(|(_, argument)| {
                    let span = argument.span();
                    span.start.offset <= quote && quote < span.end.offset
                })?;
                Some((*call, list, index))
            })
            .min_by_key(|(call, _, _)| call.span().end.offset - call.span().start.offset);
        let Some((call, list, index)) = found else { continue };
        let skip_positional = matches!(call, Expression::Instantiation(_))
            || function_name(call).is_some_and(|name| name == format!("{}each", crate::blade::VIEW_CALL_PREFIX));
        for (at, argument) in list.arguments.iter().enumerate() {
            match argument {
                Argument::Positional(argument) if at == index + 1 && !skip_positional => {
                    data(types, argument.value, &mut out);
                }
                Argument::Named(named) if [&b"data"[..], b"with", b"mergeData"].contains(&named.name.value) => {
                    data(types, named.value, &mut out);
                }
                _ => {}
            }
        }
        // `->with(…)` chained on the call.
        let span = call.span();
        for with in &calls.calls {
            let Some((object, list)) = with_object(with) else { continue };
            if object.span() != span {
                continue;
            }
            let positional: Vec<&Expression<'_>> = list
                .arguments
                .iter()
                .filter_map(|argument| match argument {
                    Argument::Positional(argument) => Some(argument.value),
                    _ => None,
                })
                .collect();
            match positional.as_slice() {
                [key, value, ..] => {
                    if let Some(key) = literal_string(key) {
                        out.push((key, type_of(types, value)));
                    }
                }
                [array] => data(types, array, &mut out),
                _ => {}
            }
        }
    }
    out
}

fn type_of<'a>(types: &ExprTypes<'a, '_>, expr: &'a Expression<'a>) -> Type {
    let frames = types.find(expr.span().start.offset).map(|(_, frames)| frames).unwrap_or_default();
    types.type_of(expr, &frames).widen()
}

/// The variables of a data argument: an array literal's string keys, or
/// `compact()`'s names.
fn data<'a>(types: &ExprTypes<'a, '_>, expr: &'a Expression<'a>, out: &mut Vec<(String, Type)>) {
    match expr {
        Expression::Parenthesized(inner) => data(types, inner.expression, out),
        Expression::Array(_) | Expression::LegacyArray(_) => {
            let elements: Vec<&ArrayElement<'_>> = match expr {
                Expression::Array(array) => array.elements.iter().collect(),
                Expression::LegacyArray(array) => array.elements.iter().collect(),
                _ => Vec::new(),
            };
            for element in elements {
                if let ArrayElement::KeyValue(element) = element
                    && let Some(key) = literal_string(element.key)
                {
                    out.push((key, type_of(types, element.value)));
                }
            }
        }
        Expression::Call(Call::Function(call)) if function_name(expr).as_deref() == Some("compact") => {
            let at = expr.span().start.offset;
            let frames = types.find(at).map(|(_, frames)| frames).unwrap_or_default();
            for argument in call.argument_list.arguments.iter() {
                if let Argument::Positional(argument) = argument
                    && let Some(name) = literal_string(argument.value)
                {
                    let ty = types.variable_type(name.as_bytes(), at, &frames).widen();
                    out.push((name, ty));
                }
            }
        }
        _ => {}
    }
}
