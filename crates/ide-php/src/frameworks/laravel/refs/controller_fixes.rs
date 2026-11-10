//! `PhpUndefinedController` ([`ControllerAction::undefined`]): a route
//! action naming a controller class or method that doesn't exist, and its
//! quick-fixes.
//!
//! What is reported, after Laravel's `Route::parseAction` and its
//! documentation on controllers:
//! - **A missing class:** the `Foo` of `'Foo@bar'` (resolved like the route
//!   resolves it, under the group's namespace), and a plain `'Foo'` action,
//!   which Laravel makes an invokable controller. A missing class written
//!   `[Foo::class, 'bar']` is left to `PhpUndefinedClass`, which reports the
//!   class name itself.
//! - **A missing method:** the `bar` of `'Foo@bar'` and `[Foo::class, 'bar']`
//!   (and of a `Route::controller(Foo::class)` group's `'bar'`), and the
//!   `__invoke` a plain `'Foo'` needs, unless the class has its own `__call`.
//!
//! The quick-fixes go through the code generation framework
//! ([`crate::frameworks::laravel::generate`]): the class is the user's
//! `controller.php.ft` template (the "Laravel Controller" file template)
//! with the method added, in the namespace and folder of Settings › PHP ›
//! Laravel › Code generation (the application's or the module's
//! `Http\Controllers`, the controller suffix), unless the route's group
//! namespace says where Laravel looks for it.
//! - "Create controller 'FooController' with method 'bar'" and "Create
//!   invokable controller 'DreamController'": the new file, and the route's
//!   string rewritten when the class's name changes (`'Foo@bar'` becomes
//!   `'FooController@bar'`, or `[FooController::class, 'bar']` outside the
//!   namespace Laravel resolves it in; `'dream'` becomes
//!   `DreamController::class`, imported).
//! - "Add method 'bar' to Foo": a public method with a `Request $request`
//!   parameter and the route's URI parameters (`{id}` → `$id`, `{id?}` →
//!   `$id = null`), last in the class, `Request` imported.

use std::path::Path;

use ide_core::WorkspaceEdit;

use super::controller_action::{controller_class, invokable};
use super::validation_actions::class_name;
use super::{RefContext, Undefined};
use crate::engine::PhpEngine;
use crate::frameworks::laravel::RouteAction;
use crate::frameworks::laravel::generate::{
    GeneratedFile, Imports, creation_edit, is_identifier, short_name, template, template::Vars,
};
use crate::imports::import_insertion;
use crate::inspect::fixes::{MemberKind, indent_unit, insert_member, newline};
use crate::names::{FileNames, NameKind};
use crate::summary::FileSummary;
use crate::syntax::ParsedFile;
use crate::types::model::ClassModel;
use crate::types::provider::laravel::studly;

const REQUEST: &str = "Illuminate\\Http\\Request";

/// A class name as a route string may write it: `Foo`, `Admin\Foo`.
fn valid_class_name(name: &str) -> bool {
    !name.is_empty() && name.trim_start_matches('\\').split('\\').all(is_identifier)
}

/// The namespace of `fqn` (empty for a global class).
fn namespace_of(fqn: &str) -> &str {
    fqn.trim_start_matches('\\').rsplit_once('\\').map_or("", |(namespace, _)| namespace)
}

/// What is wrong with the controller action `value`; see the module
/// documentation.
pub(super) fn undefined_action(cx: &RefContext<'_>, value: &str) -> Option<Undefined> {
    let resolver = cx.engine.resolver();
    if let Some(class) = invokable(cx, value) {
        if !valid_class_name(value) {
            return None;
        }
        // Found like `'Foo@bar'`'s class: also under the app's controllers.
        let known = controller_class(cx, value).filter(|known| resolver.class_model(known).is_some());
        return match resolver.class_model(known.as_deref().unwrap_or(&class)) {
            None => {
                let problem = Undefined::warning(format!("Controller class '{value}' does not exist"));
                Some(match create_controller(cx, &class, value, "__invoke", true) {
                    Some((title, edit)) => problem.with_fix(title, edit),
                    None => problem,
                })
            }
            Some(model) => missing_method(cx, &model, "__invoke"),
        };
    }
    match value.split_once('@') {
        Some((written, method)) => {
            if !valid_class_name(written) || !is_identifier(method) {
                return None;
            }
            let class = controller_class(cx, written)?;
            match resolver.class_model(&class) {
                Some(model) => missing_method(cx, &model, method),
                None => {
                    let problem = Undefined::warning(format!("Controller class '{written}' does not exist"));
                    Some(match create_controller(cx, &class, written, method, false) {
                        Some((title, edit)) => problem.with_fix(title, edit),
                        None => problem,
                    })
                }
            }
        }
        None => {
            if !is_identifier(value) {
                return None;
            }
            let site = cx.site.as_ref()?;
            // In a route file only the route's own method string (not the
            // class string of `['Foo', 'bar']`).
            let class =
                match cx.engine.laravel_routes().and_then(|routes| routes.route_at(&site.path, site.start).cloned()) {
                    Some(route) => match route.action {
                        RouteAction::Controller { class, at: Some((start, _, _)), .. } if start == site.start => class,
                        _ => return None,
                    },
                    None => site.class.clone()?,
                };
            // A missing class is `PhpUndefinedClass`'s.
            let model = resolver.class_model(&class)?;
            missing_method(cx, &model, value)
        }
    }
}

/// The problem of method `method` missing from controller `model`, with
/// "Add method"; `None` when the class has it, or handles any call itself.
fn missing_method(cx: &RefContext<'_>, model: &ClassModel, method: &str) -> Option<Undefined> {
    if model.method(method).is_some() {
        return None;
    }
    // Laravel's base controller's `__call` only throws.
    let dynamic = model
        .method("__call")
        .is_some_and(|call| !call.declaring.fqn.trim_start_matches('\\').starts_with("Illuminate\\"));
    if dynamic {
        return None;
    }
    let short = short_name(&model.class.fqn).to_owned();
    let problem = Undefined::warning(format!("Method '{method}' does not exist in controller '{short}'"));
    Some(match add_method(cx, model, method) {
        Some(edit) => problem.with_fix(format!("Add method '{method}' to {short}"), edit),
        None => problem,
    })
}

/// The parameters of a new action of the route around the site: the
/// request, then the URI's parameters.
fn action_parameters(cx: &RefContext<'_>, request: &str) -> String {
    let mut out = vec![format!("{request} $request")];
    let uri = cx.site.as_ref().and_then(|site| {
        let routes = cx.engine.laravel_routes()?;
        routes.route_at(&site.path, site.start).map(|route| route.uri.clone())
    });
    let mut rest = uri.as_deref().unwrap_or_default();
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}') else { break };
        let inner = &rest[open + 1..open + close];
        rest = &rest[open + close + 1..];
        let (name, optional) = match inner.strip_suffix('?') {
            Some(name) => (name, true),
            None => (inner, false),
        };
        // `{post:slug}` binds by `slug`, the parameter is still `$post`.
        let name = name.split(':').next().unwrap_or(name);
        if !is_identifier(name) || name == "request" {
            continue;
        }
        out.push(if optional { format!("${name} = null") } else { format!("${name}") });
    }
    out.join(", ")
}

/// A public action method, its body indented by `unit` below `indent`.
fn method_declaration(method: &str, parameters: &str, indent: &str, unit: &str, nl: &str) -> String {
    format!("public function {method}({parameters}){nl}{indent}{{{nl}{indent}{unit}//{nl}{indent}}}")
}

/// "Create controller …": `resolved` is the class Laravel looks for
/// (`App\Http\Controllers\Foo`, or a global `Foo` without a group
/// namespace), `written` how the string names it.
fn create_controller(
    cx: &RefContext<'_>,
    resolved: &str,
    written: &str,
    method: &str,
    invokable: bool,
) -> Option<(String, WorkspaceEdit)> {
    let engine = cx.engine;
    let project = &cx.project;
    let settings = engine.laravel_settings().generation;
    let target = engine.generation_target(project, &settings, None).ok()?;
    let mut short = studly(short_name(written));
    if !is_identifier(&short) {
        return None;
    }
    if !short.ends_with(settings.controller_suffix.as_str()) {
        short.push_str(&settings.controller_suffix);
    }
    // Where Laravel looks (the group's namespace), else where new
    // controllers go.
    let namespace = match namespace_of(resolved) {
        "" => target.class_namespace("Http\\Controllers"),
        namespace => namespace.to_owned(),
    };
    let fqn = format!("{namespace}\\{short}");
    if engine.resolver().class_model(&fqn).is_some() {
        return None;
    }
    let path = engine.generated_class_file(&target, &fqn);
    if engine.file_taken(&path) || engine.layout().is_some_and(|layout| path.starts_with(layout.vendor_dir())) {
        return None;
    }

    let mut imports = Imports::new(&namespace, &short);
    imports.add(&format!("{}Http\\Controllers\\Controller", project.app_namespace));
    let request = imports.add(REQUEST);
    let mut vars = Vars::new();
    vars.set("NAMESPACE", &namespace).set("CLASS", &short).set("IMPORTS", imports.lines());
    let rendered = engine.laravel_templates().render(template::CONTROLLER, &vars).ok()?;
    let parameters = action_parameters(cx, &request);
    let text =
        with_method(&rendered, &fqn, |indent, unit, nl| method_declaration(method, &parameters, indent, unit, nl))?;
    let text = if settings.type_hints { text } else { template::strip_return_types(&text) };

    let mut edit = creation_edit(vec![GeneratedFile { path, text }]);
    if !fqn.eq_ignore_ascii_case(resolved.trim_start_matches('\\')) {
        edit.files.extend(rewrite_action(cx, &namespace, &short, &fqn, method, invokable)?.files);
    }
    let title = if invokable {
        format!("Create invokable controller '{short}'")
    } else {
        format!("Create controller '{short}' with method '{method}'")
    };
    Some((title, edit))
}

/// `text` (a rendered controller template) with a method `declaration`
/// last in class `fqn`; a body holding only the template's `//` is
/// replaced.
fn with_method(text: &str, fqn: &str, declaration: impl FnOnce(&str, &str, &str) -> String) -> Option<String> {
    let class_of = |text: &str| {
        let parsed = ParsedFile::parse("controller.php", text);
        let summary = FileSummary::extract(&parsed);
        summary.class_likes.into_iter().find(|class| class.fqn.trim_start_matches('\\').eq_ignore_ascii_case(fqn))
    };
    let mut text = text.to_owned();
    let class = class_of(&text)?;
    let close = class.loc.end.checked_sub(1)? as usize;
    let open = class.name_loc.end as usize + text[class.name_loc.end as usize..close].find('{')?;
    if text[open + 1..close].trim() == "//" {
        text.replace_range(open + 1..close, "");
    }
    let class = class_of(&text)?;
    let (unit, nl) = (indent_unit(&text), newline(&text));
    let (start, end, inserted) =
        insert_member(&text, &class, MemberKind::Method, |indent| declaration(indent, unit, nl))?;
    text.replace_range(start as usize..end as usize, &inserted);
    Some(text)
}

/// The edit of the route's string naming the new class `fqn` (short name
/// `short`, in `namespace`) instead: the class part of `'Foo@bar'` when
/// Laravel resolves it in that namespace, else a class constant or array
/// callable, imported.
fn rewrite_action(
    cx: &RefContext<'_>,
    namespace: &str,
    short: &str,
    fqn: &str,
    method: &str,
    invokable: bool,
) -> Option<WorkspaceEdit> {
    let site = cx.site.as_ref()?;
    let text = cx.engine.text_of(&site.path)?;
    let parsed = ParsedFile::parse(site.path.to_string_lossy().as_ref(), text.as_str());
    let content = text.get(site.start as usize..)?;
    let quote = site.start.checked_sub(1)?;
    let close = site.start + content.find(['\'', '"'])? as u32;
    let mut edits = Vec::new();
    let resolved_namespace = cx.class().map(namespace_of).unwrap_or_default();
    if !invokable && !resolved_namespace.is_empty() && resolved_namespace.eq_ignore_ascii_case(namespace) {
        let written = content.split_once('@')?.0;
        edits.push((site.start, site.start + written.len() as u32, short.to_owned()));
    } else {
        let names = FileNames::resolve(&parsed);
        let (name, import) = class_name(cx.engine, &names, site.start, fqn);
        let replacement = if invokable { format!("{name}::class") } else { format!("[{name}::class, '{method}']") };
        edits.push((quote, close + 1, replacement));
        if let Some(import) = import {
            let (at, line) = import_insertion(&parsed, quote, NameKind::ClassLike, &import);
            edits.push((at, at, line));
        }
    }
    Some(PhpEngine::byte_edit(&parsed, &site.path, edits))
}

/// "Add method …": the edit adding action `method` to `model`'s class
/// file; `None` for a class of `vendor/`.
fn add_method(cx: &RefContext<'_>, model: &ClassModel, method: &str) -> Option<WorkspaceEdit> {
    let engine = cx.engine;
    let path = engine.class_path(&model.class, Path::new(""), &FileSummary::default())?;
    if engine.layout().is_some_and(|layout| path.starts_with(layout.vendor_dir())) {
        return None;
    }
    let text = engine.text_of(&path)?;
    let parsed = ParsedFile::parse(path.to_string_lossy().as_ref(), text.as_str());
    let summary = FileSummary::extract(&parsed);
    let class = summary.class_likes.iter().find(|class| class.fqn.eq_ignore_ascii_case(&model.class.fqn))?;
    let names = FileNames::resolve(&parsed);
    let (request, import) = class_name(engine, &names, class.loc.start, REQUEST);
    let parameters = action_parameters(cx, &request);
    let (unit, nl) = (indent_unit(&text), newline(&text));
    let mut edits = vec![insert_member(&text, class, MemberKind::Method, |indent| {
        method_declaration(method, &parameters, indent, unit, nl)
    })?];
    if let Some(import) = import {
        let (at, line) = import_insertion(&parsed, class.loc.start, NameKind::ClassLike, &import);
        edits.push((at, at, line));
    }
    Some(PhpEngine::byte_edit(&parsed, &path, edits))
}
