//! The validation refactorings, offered as `refactor.rewrite` context
//! actions where a rules array is (after IntelliJ's documented Laravel
//! actions; the rules are our own):
//!
//! - **Convert to `Rule::unique()`** (and `exists`, `in`, `dimensions`):
//!   on a rule string segment such as `unique:posts,slug`, writes it as the
//!   `Illuminate\Validation\Rule` object (`Rule::unique('posts', 'slug')`),
//!   turning a pipe string into an array of rules and importing `Rule`.
//! - **Promote validation to Form Request '…'**: on a `$request->validate([...])`
//!   (or a controller's `$this->validate($request, [...])`) in a method,
//!   creates `<Root>\Http\Requests\<Method><Base>Request` (where the
//!   autoload map puts it) with `authorize()` and a `rules()` returning the
//!   array (with the imports its class names need), injects it in place of
//!   the request parameter's type, and drops the call, or replaces it with
//!   `$request->validated()` where its value is used.
//! - **Generate validation rules from '<Model>'**: in a Form Request's
//!   `rules()` array or a `validate([...])` array, adds an entry for each
//!   column of the model the class name points to (`StorePostRequest`,
//!   `PostController` → `Post`; its `$fillable` when it has one) that the
//!   array lacks: `required` or `nullable`, then the type its cast or
//!   column gives (`integer`, `numeric`, `boolean`, `array`, `date`,
//!   `string`), and `exists:table,id` for a `…_id` column whose table exists.
//!   The title starts with "Generate", so the editor's Generate menu lists it.

use std::path::{Path, PathBuf};

use ide_core::{FileEdit, Range, TextEdit, WorkspaceEdit};
use mago_span::HasSpan;
use mago_syntax::cst::{Argument, ArrayElement, ClassLikeMemberSelector, Expression, Node, Variable};

use super::validation_rule::ValidationRule;
use super::{ArrayStep, kind_of, sites};
use crate::engine::PhpEngine;
use crate::frameworks::laravel::validation::{Segment, segments};
use crate::imports::{ImportAction, REWRITE, import_insertion, removal};
use crate::inspect::fixes::{indent_unit, line_indent, newline};
use crate::names::{FileNames, NameKind, NameRole};
use crate::navigate::enclosing_class;
use crate::summary::FileSummary;
use crate::syntax::ParsedFile;
use crate::types::provider::laravel::{LaravelProvider, plural, studly};

const RULE: &str = "Illuminate\\Validation\\Rule";
const FORM_REQUEST: &str = "Illuminate\\Foundation\\Http\\FormRequest";
const REQUEST: &str = "Illuminate\\Http\\Request";
const MODEL: &str = "Illuminate\\Database\\Eloquent\\Model";

/// The rules [`rule_object`] writes as `Rule::` objects.
const OBJECT_RULES: &[&str] = &["unique", "exists", "in", "dimensions"];

/// The nodes from the program down to the innermost one holding bytes
/// `start..end`.
fn path_to<'ast, 'arena>(root: Node<'ast, 'arena>, start: u32, end: u32) -> Vec<Node<'ast, 'arena>> {
    let mut path = vec![root];
    loop {
        let last = path[path.len() - 1];
        let next = last.children().into_iter().find(|child| {
            let span = child.span();
            span.start.offset <= start && end <= span.end.offset
        });
        match next {
            Some(child) => path.push(child),
            None => return path,
        }
    }
}

fn span(node: &impl HasSpan) -> (u32, u32) {
    let span = node.span();
    (span.start.offset, span.end.offset)
}

fn args<'a>(list: &'a mago_syntax::cst::ArgumentList<'a>) -> Vec<&'a Expression<'a>> {
    list.arguments
        .iter()
        .map(|argument| match argument {
            Argument::Positional(argument) => argument.value,
            Argument::Named(argument) => argument.value,
        })
        .collect()
}

fn method_name(selector: &ClassLikeMemberSelector<'_>) -> Option<String> {
    match selector {
        ClassLikeMemberSelector::Identifier(name) => Some(String::from_utf8_lossy(name.value).into_owned()),
        _ => None,
    }
}

/// `$name` of a plain variable.
fn variable_name(expr: &Expression<'_>) -> Option<String> {
    match expr {
        Expression::Variable(Variable::Direct(variable)) => Some(String::from_utf8_lossy(variable.name).into_owned()),
        _ => None,
    }
}

/// An array literal's parts: where its brackets are, its elements' spans
/// and its string keys.
struct ArrayParts {
    /// After the opening bracket.
    open: u32,
    /// At the closing bracket.
    close: u32,
    elements: Vec<(u32, u32)>,
    keys: Vec<String>,
}

fn array_parts(expr: &Expression<'_>) -> Option<ArrayParts> {
    let (open, close, elements) = match expr {
        Expression::Array(array) => (array.left_bracket.end.offset, array.right_bracket.start.offset, &array.elements),
        Expression::LegacyArray(array) => {
            (array.left_parenthesis.end.offset, array.right_parenthesis.start.offset, &array.elements)
        }
        _ => return None,
    };
    let mut spans = Vec::new();
    let mut keys = Vec::new();
    for element in elements.iter() {
        spans.push(span(element));
        if let ArrayElement::KeyValue(element) = element
            && let Expression::Literal(literal) = element.key
            && let crate::types::Type::LiteralString(key) = crate::types::ops::literal_type(literal)
        {
            keys.push(key);
        }
    }
    Some(ArrayParts { open, close, elements: spans, keys })
}

/// A PHP single-quoted string.
fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// `unique:posts,slug` as a `Rule::` call (`rule` is how the code writes
/// the class); `None` for rules it can't be written for.
fn rule_object(segment: &Segment<'_>, rule: &str) -> Option<String> {
    let name = segment.name.trim().to_ascii_lowercase();
    let params: Vec<&str> = segment.params?.split(',').map(str::trim).collect();
    if params.iter().any(|param| param.is_empty() || param.contains(['"', '\'', '\\', '$'])) {
        return None;
    }
    let arguments = match name.as_str() {
        "unique" | "exists" if params.len() <= 2 => {
            params.iter().map(|param| quoted(param)).collect::<Vec<_>>().join(", ")
        }
        "in" => format!("[{}]", params.iter().map(|param| quoted(param)).collect::<Vec<_>>().join(", ")),
        "dimensions" => {
            let mut entries = Vec::new();
            for param in &params {
                let (key, value) = param.split_once('=')?;
                let value = value.trim();
                let number = |text: &str| !text.is_empty() && text.parse::<f64>().is_ok();
                let value = match value.split_once('/') {
                    _ if number(value) => value.to_owned(),
                    Some((a, b)) if number(a.trim()) && number(b.trim()) => format!("{} / {}", a.trim(), b.trim()),
                    _ => quoted(value),
                };
                entries.push(format!("{} => {value}", quoted(key.trim())));
            }
            format!("[{}]", entries.join(", "))
        }
        _ => return None,
    };
    Some(format!("{rule}::{name}({arguments})"))
}

/// How code at `at` writes class `fqn`: its short name when that already
/// means it or is free (then the import to add), else fully qualified.
fn class_name(engine: &PhpEngine, names: &FileNames, at: u32, fqn: &str) -> (String, Option<String>) {
    let short = fqn.rsplit('\\').next().unwrap_or(fqn);
    let resolved = names.scope_at(at).resolve(NameKind::ClassLike, short);
    if resolved.resolution.matches(NameKind::ClassLike, fqn) {
        return (short.to_owned(), None);
    }
    let taken = resolved.imported
        || resolved.resolution.primary().is_some_and(|other| engine.declares(NameKind::ClassLike, other));
    if taken { (format!("\\{fqn}"), None) } else { (short.to_owned(), Some(fqn.to_owned())) }
}

impl PhpEngine {
    /// The validation refactorings at bytes `start..end` of `parsed` (see
    /// the module documentation). Empty outside Laravel projects.
    pub(crate) fn validation_refactorings(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        start: u32,
        end: u32,
    ) -> Vec<ImportAction> {
        if self.ref_context().is_none() {
            return Vec::new();
        }
        let mut out = self.rule_object_actions(parsed, path, start, end);
        out.extend(self.promote_to_form_request(parsed, path, start, end));
        out.extend(self.generate_rules(parsed, path, start, end));
        out
    }

    /// The edits of one file as a workspace edit, `(start, end, text)` in
    /// bytes.
    fn byte_edit(parsed: &ParsedFile, path: &Path, mut edits: Vec<(u32, u32, String)>) -> WorkspaceEdit {
        edits.sort_by_key(|(start, end, _)| (*start, *end));
        let lines = parsed.line_index();
        crate::imports::file_edit(
            path,
            edits
                .into_iter()
                .map(|(start, end, new_text)| TextEdit { range: lines.range(start, end), new_text })
                .collect(),
        )
    }

    /// "Convert to Rule::unique()" and the like.
    fn rule_object_actions(&self, parsed: &ParsedFile, path: &Path, start: u32, end: u32) -> Vec<ImportAction> {
        let resolver = self.resolver();
        let Some(site) = sites(parsed, &resolver, &[&ValidationRule], None).into_iter().find(|site| {
            site.start <= start
                && end <= site.end
                && kind_of(site, &resolver).is_some_and(|kind| kind.id() == "validationRule")
        }) else {
            return Vec::new();
        };
        let at = (start - site.start) as usize;
        let all = segments(&site.value);
        let Some(index) = all.iter().position(|segment| segment.start <= at && at <= segment.end) else {
            return Vec::new();
        };
        let name = all[index].name.trim().to_ascii_lowercase();
        if !OBJECT_RULES.contains(&name.as_str()) {
            return Vec::new();
        }
        let names = FileNames::resolve(parsed);
        let (rule, import) = class_name(self, &names, site.start, RULE);
        let Some(object) = rule_object(&all[index], &rule) else { return Vec::new() };
        let items: Vec<String> = all
            .iter()
            .enumerate()
            .filter(|(_, segment)| !site.value[segment.start..segment.end].trim().is_empty())
            .map(
                |(i, segment)| {
                    if i == index { object.clone() } else { quoted(site.value[segment.start..segment.end].trim()) }
                },
            )
            .collect();
        // A field's whole rules become an array; a string of an array of
        // rules is replaced by its items.
        let replacement = match site.steps.as_slice() {
            [ArrayStep::Value(_)] => format!("[{}]", items.join(", ")),
            _ => items.join(", "),
        };
        let mut edits = vec![(site.start - 1, site.end + 1, replacement)];
        if let Some(fqn) = import {
            let (at, line) = import_insertion(parsed, site.start, NameKind::ClassLike, &fqn);
            edits.push((at, at, line));
        }
        vec![ImportAction {
            title: format!("Convert to Rule::{name}()"),
            kind: REWRITE,
            preferred: false,
            edit: Self::byte_edit(parsed, path, edits),
        }]
    }

    /// "Promote validation to Form Request '…'".
    fn promote_to_form_request(&self, parsed: &ParsedFile, path: &Path, start: u32, end: u32) -> Vec<ImportAction> {
        let text = parsed.text();
        let nodes = path_to(Node::Program(parsed.program()), start, end);
        // The innermost `->validate(...)` call around the range.
        let Some(at) = nodes.iter().rposition(|node| {
            matches!(node, Node::MethodCall(call) if method_name(&call.method).is_some_and(|n| n.eq_ignore_ascii_case("validate")))
        }) else {
            return Vec::new();
        };
        let Node::MethodCall(call) = nodes[at] else { return Vec::new() };
        let Some(method) = nodes[..at].iter().rev().find_map(|node| match node {
            Node::Method(method) => Some(*method),
            _ => None,
        }) else {
            return Vec::new();
        };
        // No closure between the method and the call.
        if nodes[..at]
            .iter()
            .rev()
            .take_while(|node| !matches!(node, Node::Method(_)))
            .any(|node| matches!(node, Node::Closure(_) | Node::ArrowFunction(_) | Node::AnonymousClass(_)))
        {
            return Vec::new();
        }
        let arguments = args(&call.argument_list);
        let (variable, array) = match variable_name(call.object).as_deref() {
            Some("$this") => match arguments.as_slice() {
                [request, array, ..] => (variable_name(request), *array),
                _ => return Vec::new(),
            },
            Some(name) => match arguments.as_slice() {
                [array, ..] => (Some(name.to_owned()), *array),
                _ => return Vec::new(),
            },
            None => return Vec::new(),
        };
        let Some(variable) = variable else { return Vec::new() };
        if array_parts(array).is_none_or(|parts| parts.elements.is_empty()) {
            return Vec::new();
        }
        // The rules array must be one Laravel validates.
        let resolver = self.resolver();
        let (array_start, array_end) = span(array);
        let validated = sites(parsed, &resolver, &[&ValidationRule], None).into_iter().any(|site| {
            array_start <= site.start
                && site.end <= array_end
                && kind_of(&site, &resolver).is_some_and(|kind| kind.id() == "validationRule")
        });
        if !validated {
            return Vec::new();
        }
        // The parameter holding the request, typed as a plain request.
        let Some(param) = method
            .parameter_list
            .parameters
            .iter()
            .find(|param| String::from_utf8_lossy(param.variable.name) == variable.as_str())
        else {
            return Vec::new();
        };
        let Some(hint) = &param.hint else { return Vec::new() };
        let names = FileNames::resolve(parsed);
        let (hint_start, hint_end) = span(hint);
        let is_request = names
            .at_offset(hint_start)
            .is_some_and(|name| name.end == hint_end && name.resolution.matches(NameKind::ClassLike, REQUEST));
        if !is_request {
            return Vec::new();
        }
        // The new class.
        let summary = FileSummary::extract(parsed);
        let Some(class) = enclosing_class(&summary, start) else { return Vec::new() };
        let controller = class.fqn.rsplit('\\').next().unwrap_or(&class.fqn);
        let base = controller.strip_suffix("Controller").unwrap_or(controller);
        let method_name = String::from_utf8_lossy(method.name.value).into_owned();
        let verb = if method_name.starts_with("__") { String::new() } else { studly(&method_name) };
        let short = format!("{verb}{base}Request");
        let namespace = match class.fqn.find("\\Http\\Controllers") {
            Some(at) => format!("{}\\Http\\Requests", &class.fqn[..at]),
            None => match class.fqn.split_once('\\') {
                Some((root, _)) => format!("{root}\\Http\\Requests"),
                None => "Http\\Requests".to_owned(),
            },
        };
        let fqn = format!("{namespace}\\{short}");
        let Some(layout) = self.layout() else { return Vec::new() };
        let Some(file): Option<PathBuf> = layout.autoload().class_files(&fqn).into_iter().next() else {
            return Vec::new();
        };
        if file.exists() || self.open_document(&file).is_some() {
            return Vec::new();
        }

        // Its file: the rules array re-indented, with the imports of the
        // classes it names.
        let unit = "    ";
        let array_text = &text[array_start as usize..array_end as usize];
        let from = line_indent(text, array_start);
        let rules = crate::refactor::hierarchy::reindent(array_text, from, &unit.repeat(2)).replace("\r\n", "\n");
        let mut imports = vec![FORM_REQUEST.to_owned()];
        for name in names.names() {
            if name.start < array_start || array_end < name.end || name.kind != NameKind::ClassLike {
                continue;
            }
            if name.role != NameRole::Reference || name.text.starts_with('\\') || name.text.contains('\\') {
                continue;
            }
            if let Some(target) = name.resolution.primary().filter(|fqn| fqn.contains('\\')) {
                let target = target.trim_start_matches('\\').to_owned();
                if !imports.iter().any(|known| known.eq_ignore_ascii_case(&target)) {
                    imports.push(target);
                }
            }
        }
        imports.sort_by_key(|fqn| fqn.to_ascii_lowercase());
        let mut content = String::from("<?php\n\n");
        if text.contains("declare(strict_types=1)") {
            content.push_str("declare(strict_types=1);\n\n");
        }
        content.push_str(&format!("namespace {namespace};\n\n"));
        for import in &imports {
            content.push_str(&format!("use {import};\n"));
        }
        content.push_str(&format!(
            "\nclass {short} extends FormRequest\n{{\n{unit}public function authorize(): bool\n{unit}{{\n{unit}{unit}return true;\n{unit}}}\n\n{unit}/** @return array<string, mixed> */\n{unit}public function rules(): array\n{unit}{{\n{unit}{unit}return {rules};\n{unit}}}\n}}\n"
        ));

        // The controller: the parameter's type, the call, the import.
        let mut edits = Vec::new();
        let (type_name, import) = class_name(self, &names, hint_start, &fqn);
        edits.push((hint_start, hint_end, type_name));
        let (call_start, call_end) = span(&nodes[at]);
        // Up through the expression wrappers to the statement, if any.
        let mut up = at;
        while up > 0 && matches!(nodes[up - 1], Node::Expression(_) | Node::Call(_)) {
            up -= 1;
        }
        let statement = match nodes.get(up.wrapping_sub(1)) {
            Some(Node::ExpressionStatement(statement)) if span(*statement).0 == call_start => Some(span(*statement)),
            _ => None,
        };
        match statement {
            Some((from, to)) => {
                let (from, to) = removal(text, from, to);
                edits.push((from, to, String::new()));
            }
            None => edits.push((call_start, call_end, format!("{variable}->validated()"))),
        }
        if let Some(import) = import {
            let (at, line) = import_insertion(parsed, hint_start, NameKind::ClassLike, &import);
            edits.push((at, at, line));
        }
        let mut edit = WorkspaceEdit {
            files: vec![
                FileEdit::Create { path: file.clone().into(), overwrite: false },
                FileEdit::Edit {
                    path: file.into(),
                    edits: vec![TextEdit { range: Range::default(), new_text: content }],
                    version: None,
                },
            ],
            preconditions: Vec::new(),
        };
        edit.files.extend(Self::byte_edit(parsed, path, edits).files);
        vec![ImportAction {
            title: format!("Promote validation to Form Request '{short}'"),
            kind: REWRITE,
            preferred: false,
            edit,
        }]
    }

    /// "Generate validation rules from '<Model>'".
    fn generate_rules(&self, parsed: &ParsedFile, path: &Path, start: u32, end: u32) -> Vec<ImportAction> {
        let text = parsed.text();
        let nodes = path_to(Node::Program(parsed.program()), start, end);
        let resolver = self.resolver();
        let summary = FileSummary::extract(parsed);
        let Some(class) = enclosing_class(&summary, start) else { return Vec::new() };
        let is_form_request = resolver.class_model(&class.fqn).is_some_and(|model| model.is_subclass_of(FORM_REQUEST));
        // The rules array: what a Form Request's `rules()` returns, or the
        // array of a `validate([...])` call.
        let mut found = None;
        for (i, node) in nodes.iter().enumerate().rev() {
            let Node::Expression(expr @ (Expression::Array(_) | Expression::LegacyArray(_))) = node else { continue };
            let in_rules = is_form_request
                && matches!(nodes.get(i.wrapping_sub(1)), Some(Node::Return(_)))
                && nodes[..i].iter().rev().find_map(|node| match node {
                    Node::Method(method) => Some(method.name.value.eq_ignore_ascii_case(b"rules")),
                    Node::Closure(_) | Node::ArrowFunction(_) => Some(false),
                    _ => None,
                }) == Some(true);
            let in_validate = nodes[..i].iter().rev().take(6).any(|node| match node {
                Node::MethodCall(call) => {
                    method_name(&call.method).is_some_and(|name| name.eq_ignore_ascii_case("validate"))
                        && args(&call.argument_list).iter().any(|arg| span(*arg) == span(*expr))
                }
                _ => false,
            });
            if in_rules || in_validate {
                found = Some(*expr);
            }
            break;
        }
        let Some(array) = found else { return Vec::new() };
        let Some(ArrayParts { open, close, elements, keys }) = array_parts(array) else { return Vec::new() };
        // The model the class name points to.
        let short = class.fqn.rsplit('\\').next().unwrap_or(&class.fqn);
        let base = short.strip_suffix("Request").or_else(|| short.strip_suffix("Controller")).unwrap_or(short);
        let mut candidates = vec![base.to_owned()];
        for verb in ["Store", "Update", "Create", "Edit", "Save", "Upsert", "Destroy", "Delete"] {
            if let Some(rest) = base.strip_prefix(verb).filter(|rest| rest.starts_with(char::is_uppercase)) {
                candidates.insert(0, rest.to_owned());
            }
        }
        let root = class.fqn.split('\\').next().unwrap_or_default();
        let model = candidates.iter().find_map(|name| {
            [format!("{root}\\Models\\{name}"), format!("{root}\\{name}")]
                .into_iter()
                .find_map(|fqn| resolver.class_model(&fqn).filter(|model| model.is_subclass_of(MODEL)))
        });
        let Some(model) = model else { return Vec::new() };
        let fillable: Vec<String> = model
            .property("fillable")
            .and_then(|property| property.declared())
            .and_then(|property| property.default.clone())
            .map(|value| {
                value
                    .split(',')
                    .map(|item| {
                        item.trim().trim_matches(['[', ']', ' ', '\n', '\r', '\t']).trim_matches(['\'', '"']).to_owned()
                    })
                    .filter(|item| !item.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let facts = resolver.laravel();
        const SKIPPED: &[&str] = &["id", "created_at", "updated_at", "deleted_at", "remember_token"];
        let mut entries = Vec::new();
        for (column, cast) in LaravelProvider::model_columns(&resolver, model.fqn()) {
            let name = &column.name;
            if SKIPPED.contains(&name.as_str())
                || keys.contains(name)
                || (!fillable.is_empty() && !fillable.contains(name))
            {
                continue;
            }
            let mut rules = vec![if column.nullable { "nullable".to_owned() } else { "required".to_owned() }];
            let ty = column.ty.0.trim_start_matches('\\');
            let type_rule =
                match cast.as_deref().map(|cast| cast.split(':').next().unwrap_or(cast).to_ascii_lowercase()) {
                    Some(cast) if cast.starts_with('\\') => None,
                    Some(cast) => match cast.as_str() {
                        "int" | "integer" => Some("integer"),
                        "real" | "float" | "double" | "decimal" => Some("numeric"),
                        "bool" | "boolean" => Some("boolean"),
                        "array" | "json" | "collection" | "object" => Some("array"),
                        "date" | "datetime" | "immutable_date" | "immutable_datetime" | "timestamp" => Some("date"),
                        "string" => Some("string"),
                        _ => None,
                    },
                    None => match ty {
                        "int" => Some("integer"),
                        "float" => Some("numeric"),
                        "bool" => Some("boolean"),
                        "string" => Some("string"),
                        _ if ty.ends_with("Carbon") || ty.ends_with("CarbonImmutable") => Some("date"),
                        _ => None,
                    },
                };
            rules.extend(type_rule.map(str::to_owned));
            if let Some(prefix) = name.strip_suffix("_id") {
                let table = plural(prefix);
                if facts.tables.iter().any(|known| known.name == table) {
                    rules.push(format!("exists:{table},id"));
                }
            }
            entries.push(format!("{} => {}", quoted(name), quoted(&rules.join("|"))));
        }
        if entries.is_empty() {
            return Vec::new();
        }
        let nl = newline(text);
        let (array_start, _) = span(array);
        let close_indent = line_indent(text, array_start).to_owned();
        let indent = match elements.first() {
            Some((first, _))
                if text[..*first as usize].ends_with([' ', '\t'])
                    && text[open as usize..*first as usize].contains('\n') =>
            {
                line_indent(text, *first).to_owned()
            }
            _ => format!("{close_indent}{}", indent_unit(text)),
        };
        let body: String = entries.iter().map(|entry| format!("{nl}{indent}{entry},")).collect();
        let edit = match elements.last() {
            Some((_, last_end)) => {
                let between = &text[*last_end as usize..close as usize];
                let comma = if between.trim_start().starts_with(',') { "" } else { "," };
                let after = if between.trim_start().starts_with(',') {
                    *last_end + between.find(',').unwrap_or(0) as u32 + 1
                } else {
                    *last_end
                };
                (after, close, format!("{comma}{body}{nl}{close_indent}"))
            }
            None => (open, close, format!("{body}{nl}{close_indent}")),
        };
        let model_name = model.fqn().rsplit('\\').next().unwrap_or(model.fqn()).to_owned();
        vec![ImportAction {
            title: format!("Generate validation rules from '{model_name}'"),
            kind: REWRITE,
            preferred: false,
            edit: Self::byte_edit(parsed, path, vec![edit]),
        }]
    }
}
