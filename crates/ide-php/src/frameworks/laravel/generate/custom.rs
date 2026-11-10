//! The code generations of `ide.json` files (`codeGenerations`, read by
//! [`crate::frameworks::laravel::ide_json`]) as generators of the Laravel ›
//! Generate menu, with the id `ide-json:<id>` ([`PREFIX`]).
//!
//! An entry's `parameters` are the extra input fields of its dialog
//! ([`GeneratorField`]): text fields, checkboxes and choices, each setting a
//! template variable. Its `files` are rendered from the template each names:
//! a stub file relative to the `ide.json` (`template.path`, else
//! `template.fallbackPath`), or with `"type": "fileTemplate"` a file
//! template of Settings › Editor › File and Code Templates by name.
//!
//! A file is a class of the application or module namespace plus
//! `appNamespace` (placed where the autoload map puts it), or with
//! `directory` a file of that folder of the project (or module). `name` is
//! its file name (default: the class's). The class is the name typed in the
//! dialog (sub-namespaces with `/`), with `classSuffix` added.
//!
//! Rendering: the `template.parameters` replace their keys in the stub
//! (`{{ key }}` and `{{key}}`, as Laravel's stubs use them; also the key as
//! written when it isn't a lower-case word, like `DummyClass`), then `${NAME}` and `${NAME|filter|…}` expressions are expanded
//! ([`expand`]), then the result goes through the file-template renderer of
//! [`super::template`] (`$NAME$`, `#if`). The variables are
//! - `INPUT`: the name as typed (`Admin\Report`);
//! - `INPUT_CLASS` and `CLASS`: the class (`ReportDto`);
//! - `INPUT_FQN`, `NAMESPACE`: the class's FQN and namespace;
//! - `APP_NAMESPACE`: the application's (or module's) namespace;
//! - `CLASS_SUFFIX`;
//! - `BASE_CLASS`, `BASE_CLASS_NAME`: `baseClass` when the project has it,
//!   else `fallbackBaseClass`;
//! - each parameter's `variable`.
//!
//! The name typed goes through `inputFilter` first: filters of the
//! `${…|filter}` expressions separated by `|` (`upperCamelCase`), applied
//! to each segment of the name. Then it must match `regex` as a whole, when
//! given, and be a valid class name as for the other generators.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::classes::{class_parts, kebab};
use super::template::{self, TemplateSet, Vars};
use super::{NewClass, Target, camel, short_name};
use crate::engine::PhpEngine;
use crate::frameworks::laravel::IdeJson;
use crate::types::provider::laravel::{plural, snake, studly};

/// The id prefix of the generators of `ide.json` code generations.
pub const PREFIX: &str = "ide-json:";

/// An input field of a generator's dialog.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorField {
    /// The key of its value in [`NewClass::inputs`].
    pub id: String,
    pub title: String,
    /// `text`, `checkbox` or `select`.
    pub kind: String,
    /// The template variable it sets.
    pub variable: String,
    pub optional: bool,
    /// The value when left empty (`true` for a ticked checkbox).
    pub default: String,
    /// The choices of a `select`.
    pub options: Vec<FieldOption>,
}

/// A choice of a `select` field.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldOption {
    pub value: String,
    pub label: String,
}

/// A code generation of an `ide.json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeGeneration {
    /// `ide-json:<id>`.
    pub id: String,
    pub title: String,
    /// The `ide.json` declaring it.
    pub file: PathBuf,
    pub class_suffix: String,
    /// `inputFilter`: the filters applied to the name typed.
    pub input_filter: Vec<String>,
    /// `regex`: the pattern the (filtered) name must match.
    pub regex: Option<String>,
    pub fields: Vec<GeneratorField>,
    pub files: Vec<CodeFile>,
}

/// A file a code generation creates.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeFile {
    /// The file name, with expressions.
    pub name: Option<String>,
    /// The namespace below the application's (`Data\Transfer`).
    pub app_namespace: Option<String>,
    /// The folder, relative to the project (or module).
    pub directory: Option<String>,
    pub base_class: Option<String>,
    pub fallback_base_class: Option<String>,
    pub template: TemplateSource,
    /// `template.parameters`: `(placeholder, expression)`, longest first.
    pub parameters: Vec<(String, String)>,
}

/// Where a file's template comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TemplateSource {
    /// A stub file (absolute), and the one to read when it's missing.
    Stub { path: PathBuf, fallback: Option<PathBuf> },
    /// A file template by name (`Laravel Model`).
    FileTemplate(String),
}

impl TemplateSource {
    /// How the generator list shows it: the stub's path, or the template's name.
    pub fn label(&self) -> String {
        match self {
            Self::Stub { path, .. } => path.to_string_lossy().into_owned(),
            Self::FileTemplate(name) => name.clone(),
        }
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// A value as text: strings as written, booleans and numbers printed.
fn scalar(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => if *b { "true" } else { "" }.to_owned(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn field(value: &Value) -> Option<GeneratorField> {
    let id = text(value.get("id"))?;
    let variable = text(value.get("variable")).unwrap_or_else(|| id.to_ascii_uppercase());
    let kind = match value.get("type").and_then(Value::as_str).unwrap_or("string") {
        "checkbox" | "boolean" | "bool" => "checkbox",
        "select" | "enum" | "list" | "choice" => "select",
        _ => "text",
    };
    let mut options: Vec<FieldOption> = match value.get("options") {
        Some(Value::Object(map)) => map
            .iter()
            .map(|(value, label)| FieldOption {
                value: value.clone(),
                label: label.as_str().filter(|l| !l.is_empty()).unwrap_or(value).to_owned(),
            })
            .collect(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(|value| FieldOption { value: value.to_owned(), label: value.to_owned() })
            .collect(),
        _ => Vec::new(),
    };
    let kind = if kind == "select" && options.is_empty() { "text" } else { kind };
    if kind != "select" {
        options.clear();
    }
    Some(GeneratorField {
        title: text(value.get("name")).unwrap_or_else(|| id.clone()),
        id,
        kind: kind.to_owned(),
        variable,
        optional: value.get("optional").and_then(Value::as_bool).unwrap_or(kind == "checkbox"),
        default: scalar(value.get("defaultValue")),
        options,
    })
}

fn code_file(dir: &std::path::Path, value: &Value) -> Option<CodeFile> {
    let template = value.get("template")?;
    let source = match template.get("type").and_then(Value::as_str) {
        Some("fileTemplate") => TemplateSource::FileTemplate(text(template.get("path"))?),
        _ => {
            let at = |rel: String| crate::project::normalize(&dir.join(rel.trim_start_matches(['/', '\\'])));
            TemplateSource::Stub {
                path: at(text(template.get("path"))?),
                fallback: text(template.get("fallbackPath")).map(at),
            }
        }
    };
    let mut parameters: Vec<(String, String)> = template
        .get("parameters")
        .and_then(Value::as_object)
        .map(|map| map.iter().map(|(key, value)| (key.clone(), scalar(Some(value)))).collect())
        .unwrap_or_default();
    parameters.sort_by_key(|(key, _)| std::cmp::Reverse(key.len()));
    Some(CodeFile {
        name: text(value.get("name")),
        app_namespace: value.get("appNamespace").and_then(Value::as_str).map(|ns| ns.trim_matches('\\').to_owned()),
        directory: text(value.get("directory")),
        base_class: text(value.get("baseClass")).map(|c| c.trim_start_matches('\\').to_owned()),
        fallback_base_class: text(value.get("fallbackBaseClass")).map(|c| c.trim_start_matches('\\').to_owned()),
        template: source,
        parameters,
    })
}

/// The code generations of `ide`, the project's first; a later one with
/// the id of an earlier one is left out, and so are entries without a file
/// to render.
pub fn code_generations(ide: &IdeJson) -> Vec<CodeGeneration> {
    let mut out: Vec<CodeGeneration> = Vec::new();
    for (i, (file, value)) in ide.code_generations.iter().enumerate() {
        let dir = file.parent().unwrap_or(std::path::Path::new(""));
        let raw_id = text(value.get("id")).unwrap_or_else(|| format!("{i}"));
        let id = format!("{PREFIX}{raw_id}");
        if out.iter().any(|known| known.id == id) {
            tracing::info!("{}: codeGenerations '{raw_id}' is declared already", file.display());
            continue;
        }
        let files: Vec<CodeFile> = value
            .get("files")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|f| code_file(dir, f))
            .collect();
        if files.is_empty() {
            tracing::info!("{}: codeGenerations '{raw_id}' has no file with a template", file.display());
            continue;
        }
        let mut fields: Vec<GeneratorField> = Vec::new();
        for f in value.get("parameters").and_then(Value::as_array).into_iter().flatten().filter_map(field) {
            if !fields.iter().any(|known| known.id == f.id) {
                fields.push(f);
            }
        }
        out.push(CodeGeneration {
            title: text(value.get("name")).unwrap_or_else(|| raw_id.clone()),
            id,
            file: file.clone(),
            class_suffix: text(value.get("classSuffix")).unwrap_or_default(),
            input_filter: text(value.get("inputFilter"))
                .map(|filters| filters.split('|').map(str::trim).filter(|f| !f.is_empty()).map(str::to_owned).collect())
                .unwrap_or_default(),
            regex: text(value.get("regex")),
            fields,
            files,
        });
    }
    out
}

impl CodeGeneration {
    /// The name typed for this generation, through its `inputFilter`, and
    /// checked against its `regex`.
    pub fn input_name(&self, typed: &str) -> Result<String, String> {
        let typed = typed.trim();
        if typed.is_empty() {
            return Err("Enter a name".to_owned());
        }
        let mut name = typed.replace('/', "\\");
        for f in &self.input_filter {
            name = name.split('\\').map(|segment| filter(segment, f)).collect::<Result<Vec<_>, _>>()?.join("\\");
        }
        if let Some(pattern) = &self.regex {
            let regex = regex_lite::Regex::new(&format!("^(?:{pattern})$"))
                .map_err(|e| format!("The regex of {} is invalid: {e}", self.title))?;
            if !regex.is_match(&name) {
                return Err(format!("'{name}' doesn't match {pattern}"));
            }
        }
        Ok(name)
    }
}

/// `value` with `filter` applied (`className`, `namespace`, `upperCamelCase`,
/// `camelCase`, `snakeCase`, `kebabCase`, `lowerCase`, `upperCase`,
/// `plural`); the case filters work on each segment of a name.
pub(crate) fn filter(value: &str, filter: &str) -> Result<String, String> {
    let segments = |f: &dyn Fn(&str) -> String| value.split('\\').map(f).collect::<Vec<_>>().join("\\");
    Ok(match filter {
        "className" => short_name(value).to_owned(),
        "namespace" => value.rsplit_once('\\').map_or("", |(ns, _)| ns).to_owned(),
        "upperCamelCase" | "studlyCase" | "pascalCase" => segments(&studly),
        "camelCase" | "lowerCamelCase" => segments(&camel),
        "snakeCase" => segments(&snake),
        "kebabCase" => segments(&kebab),
        "lowerCase" => value.to_lowercase(),
        "upperCase" => value.to_uppercase(),
        "plural" => segments(&plural),
        other => return Err(format!("Unknown filter '{other}'")),
    })
}

fn is_variable(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_uppercase() || c == '_')
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// Expands the `${NAME}` and `${NAME|filter|…}` expressions of `text`.
/// Unknown variables, and braces that aren't an expression, stay as
/// written; an unknown filter fails.
pub fn expand(text: &str, vars: &Vars) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("${") {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(close) = rest.find('}') else { break };
        let inner = &rest[2..close];
        let mut parts = inner.split('|').map(str::trim);
        let name = parts.next().unwrap_or_default();
        match vars.get(name).filter(|_| is_variable(name)) {
            Some(value) => {
                let mut value = value.to_owned();
                for f in parts {
                    value = filter(&value, f)?;
                }
                out.push_str(&value);
            }
            None => out.push_str(&rest[..=close]),
        }
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Replaces the stub placeholders of `parameters` (already expanded) in `body`.
fn replace_placeholders(body: &str, parameters: &[(String, String)]) -> String {
    let mut body = body.to_owned();
    for (key, value) in parameters {
        for form in [format!("{{{{ {key} }}}}"), format!("{{{{{key}}}}}")] {
            body = body.replace(&form, value);
        }
    }
    // A lower-case word (`namespace`) is also PHP's: only in braces.
    let word = |key: &str| key.chars().all(|c| c.is_ascii_lowercase() || c == '_');
    for (key, value) in parameters {
        if !key.is_empty() && !word(key) {
            body = body.replace(key.as_str(), value);
        }
    }
    body
}

impl PhpEngine {
    /// The code generations of the project's `ide.json` files.
    pub fn laravel_code_generations(&self) -> Vec<CodeGeneration> {
        self.laravel().map(|project| code_generations(&project.ide_json)).unwrap_or_default()
    }

    /// The files of code generation `generation` for `spec`: `(path, text)`.
    pub(super) fn code_generation_files(
        &self,
        generation: &CodeGeneration,
        target: &Target<'_>,
        templates: &TemplateSet,
        spec: &NewClass,
    ) -> Result<Vec<(PathBuf, String)>, String> {
        let name = generation.input_name(&spec.name)?;
        let (sub, class) = class_parts(&name, &generation.class_suffix)?;
        let app_namespace = target.namespace.trim_end_matches('\\').to_owned();
        let mut base = Vars::new();
        base.set("INPUT", name.trim_end_matches(".php").replace('/', "\\").trim_matches('\\'))
            .set("INPUT_CLASS", class.clone())
            .set("CLASS", class.clone())
            .set("APP_NAMESPACE", app_namespace.clone())
            .set("CLASS_SUFFIX", generation.class_suffix.clone());
        for field in &generation.fields {
            let given = spec.inputs.get(&field.id).map(|v| v.trim().to_owned()).unwrap_or_default();
            let value = match field.kind.as_str() {
                "checkbox" => {
                    let on = if spec.inputs.contains_key(&field.id) { given } else { field.default.clone() };
                    if matches!(on.as_str(), "" | "false" | "0") { String::new() } else { "true".to_owned() }
                }
                _ if given.is_empty() => field.default.clone(),
                _ => given,
            };
            if field.kind == "select" && !value.is_empty() && !field.options.iter().any(|o| o.value == value) {
                return Err(format!("'{value}' is not a choice of {}", field.title));
            }
            if field.kind != "checkbox" && !field.optional && value.is_empty() {
                return Err(format!("Enter {}", field.title));
            }
            base.set(&field.variable, value);
        }
        let resolver = self.resolver();
        let mut out = Vec::new();
        for file in &generation.files {
            let mut vars = base.clone();
            let (namespace, dir) = match &file.directory {
                Some(directory) => {
                    let root = target.module.map_or(&target.project.paths.base, |module| &module.path);
                    let mut dir = root.join(expand(directory, &vars)?.trim_matches(['/', '\\']));
                    dir.extend(&sub);
                    let dir = crate::project::normalize(&dir);
                    let namespace = self
                        .layout()
                        .and_then(|layout| layout.autoload().namespace_of_dir(&dir))
                        .unwrap_or_else(|| join_namespace(&[app_namespace.as_str()], &sub));
                    (namespace, Some(dir))
                }
                None => {
                    let relative = match &file.app_namespace {
                        Some(ns) => expand(ns, &vars)?.trim_matches('\\').to_owned(),
                        None => String::new(),
                    };
                    (join_namespace(&[app_namespace.as_str(), relative.as_str()], &sub), None)
                }
            };
            let fqn = if namespace.is_empty() { class.clone() } else { format!("{namespace}\\{class}") };
            vars.set("NAMESPACE", namespace).set("INPUT_FQN", fqn.clone());
            let base_class = file
                .base_class
                .as_ref()
                .filter(|c| resolver.class_model(c).is_some())
                .or(file.fallback_base_class.as_ref())
                .or(file.base_class.as_ref());
            if let Some(base_class) = base_class {
                vars.set("BASE_CLASS", base_class.clone()).set("BASE_CLASS_NAME", short_name(base_class));
            }
            let file_name = match &file.name {
                Some(name) => expand(name, &vars)?,
                None => format!("{class}.php"),
            };
            if file_name.is_empty() || file_name.contains(['/', '\\']) && file_name.contains("..") {
                return Err(format!("'{file_name}' is not a file name"));
            }
            let path = match dir {
                Some(dir) => dir.join(&file_name),
                None => {
                    let path = self.generated_class_file(target, &fqn);
                    if file.name.is_some() { path.with_file_name(&file_name) } else { path }
                }
            };
            let body = match &file.template {
                TemplateSource::FileTemplate(name) => {
                    templates.body(name).ok_or_else(|| format!("There is no template '{name}'"))?.to_owned()
                }
                TemplateSource::Stub { path, fallback } => std::iter::once(path)
                    .chain(fallback)
                    .find_map(|path| self.text_of(path).or_else(|| std::fs::read_to_string(path).ok()))
                    .ok_or_else(|| format!("Cannot read the template {}", path.display()))?,
            };
            let parameters: Vec<(String, String)> = file
                .parameters
                .iter()
                .map(|(key, value)| Ok((key.clone(), expand(value, &vars)?)))
                .collect::<Result<_, String>>()?;
            let body = expand(&replace_placeholders(&body, &parameters), &vars)?;
            let text = template::render(&body, &vars).map_err(|e| format!("{}: {e}", file.template.label()))?;
            out.push((path, text));
        }
        Ok(out)
    }
}

/// `App` + `Data` + `[Admin]` → `App\Data\Admin`, leaving out empty parts.
fn join_namespace(parts: &[&str], sub: &[String]) -> String {
    parts
        .iter()
        .map(|part| part.trim_matches('\\'))
        .chain(sub.iter().map(String::as_str))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\\")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vars {
        let mut vars = Vars::new();
        for (name, value) in pairs {
            vars.set(name, *value);
        }
        vars
    }

    #[test]
    fn expressions_expand_with_filters() {
        let vars = vars(&[("INPUT_FQN", "App\\Data\\Admin\\ReportDto"), ("NAME", "order_line")]);
        assert_eq!(
            expand("namespace ${INPUT_FQN|namespace}; class ${INPUT_FQN|className} {}", &vars).unwrap(),
            "namespace App\\Data\\Admin; class ReportDto {}"
        );
        assert_eq!(
            expand("${NAME|upperCamelCase}-${NAME|camelCase}-${NAME|kebabCase}", &vars).unwrap(),
            "OrderLine-orderLine-order-line"
        );
        assert_eq!(expand("${NAME|plural|upperCase}", &vars).unwrap(), "ORDER_LINES");
        // PHP's own `${…}` and unknown variables stay.
        assert_eq!(expand("\"${foo}\" ${MISSING} ${", &vars).unwrap(), "\"${foo}\" ${MISSING} ${");
        assert!(expand("${NAME|shout}", &vars).unwrap_err().contains("shout"));
    }

    #[test]
    fn names_go_through_the_input_filter_and_the_regex() {
        let mut ide = IdeJson::default();
        let entry = serde_json::json!({
            "id": "dto",
            "name": "DTO",
            "inputFilter": "upperCamelCase",
            "regex": "[A-Z][A-Za-z]*(\\\\[A-Z][A-Za-z]*)*",
            "files": [{ "template": { "type": "fileTemplate", "path": "Laravel Model" } }]
        });
        ide.code_generations.push((PathBuf::from("/p/ide.json"), entry));
        let dto = &code_generations(&ide)[0];
        assert_eq!(dto.input_filter, ["upperCamelCase"]);
        assert_eq!(dto.input_name("admin/order_line").unwrap(), "Admin\\OrderLine");
        assert!(dto.input_name("Order2").unwrap_err().contains("doesn't match"));
        assert_eq!(dto.input_name("  ").unwrap_err(), "Enter a name");
        let broken = CodeGeneration { regex: Some("(".to_owned()), input_filter: Vec::new(), ..dto.clone() };
        assert!(broken.input_name("X").unwrap_err().contains("invalid"));
        let unknown = CodeGeneration { input_filter: vec!["shout".to_owned()], regex: None, ..dto.clone() };
        assert!(unknown.input_name("x").unwrap_err().contains("shout"));
    }

    #[test]
    fn stub_placeholders_are_replaced() {
        let params = vec![("DummyClass".to_owned(), "Report".to_owned()), ("namespace".to_owned(), "App".to_owned())];
        assert_eq!(
            replace_placeholders("namespace {{ namespace }};\nclass DummyClass {{namespace}}", &params),
            "namespace App;\nclass Report App"
        );
    }

    #[test]
    fn entries_map_onto_generators() {
        let mut ide = IdeJson::default();
        let file = PathBuf::from("/p/ide.json");
        let entry = serde_json::json!({
            "id": "acme.dto",
            "name": "Data Transfer Object",
            "classSuffix": "Dto",
            "parameters": [
                { "id": "readonly", "name": "Read-only", "type": "checkbox", "variable": "READONLY", "defaultValue": "true" },
                { "id": "kind", "name": "Kind", "type": "select", "variable": "KIND", "options": { "in": "Input", "out": "" } },
                { "id": "note", "name": "Note", "type": "string", "variable": "NOTE" },
                { "name": "No id" }
            ],
            "files": [
                { "appNamespace": "Data", "template": { "type": "stub", "path": "/stubs/dto.stub", "parameters": { "DummyClass": "${CLASS}" } } },
                { "template": { "type": "fileTemplate", "path": "Laravel Model" } },
                { "name": "no template" }
            ]
        });
        ide.code_generations.push((file.clone(), entry.clone()));
        ide.code_generations.push((PathBuf::from("/p/vendor/a/b/ide.json"), entry));
        ide.code_generations.push((file.clone(), serde_json::json!({ "id": "empty", "files": [] })));
        let generations = code_generations(&ide);
        assert_eq!(generations.len(), 1, "the duplicate id and the entry without files are left out");
        let dto = &generations[0];
        assert_eq!(dto.id, "ide-json:acme.dto");
        assert_eq!(dto.title, "Data Transfer Object");
        assert_eq!(dto.class_suffix, "Dto");
        assert_eq!(dto.files.len(), 2);
        assert_eq!(dto.files[0].app_namespace.as_deref(), Some("Data"));
        assert_eq!(
            dto.files[0].template,
            TemplateSource::Stub {
                path: crate::project::normalize(std::path::Path::new("/p/stubs/dto.stub")),
                fallback: None
            }
        );
        assert_eq!(dto.files[1].template, TemplateSource::FileTemplate("Laravel Model".to_owned()));
        let kinds: Vec<(&str, &str, bool)> =
            dto.fields.iter().map(|f| (f.id.as_str(), f.kind.as_str(), f.optional)).collect();
        assert_eq!(kinds, [("readonly", "checkbox", true), ("kind", "select", false), ("note", "text", false)]);
        assert_eq!(dto.fields[0].default, "true");
        assert_eq!(
            dto.fields[1].options,
            [
                FieldOption { value: "in".to_owned(), label: "Input".to_owned() },
                FieldOption { value: "out".to_owned(), label: "out".to_owned() }
            ]
        );
    }
}
