//! The `validationRule` and `requestField` reference kinds, as Laravel's
//! validation documentation describes the places rules are written in:
//!
//! - **`validationRule`**: the rules of a field, a pipe string or an
//!   array of strings, in the array of `$request->validate([...])`,
//!   `validateWithBag('bag', [...])`, `Validator::make($data, [...])`,
//!   `validator($data, [...])`, a controller's `$this->validate($request,
//!   [...])` and what a Form Request's `rules()` returns. Completion offers
//!   the rule names of the segment at the caret ([`RULES`]), then its
//!   parameters: tables and their columns from the migrations for
//!   `exists:` and `unique:`, and the other fields of the rules array for
//!   `required_if:`, `same:` and the like. Goto opens a column's migration
//!   or a field's rule entry. A rule that is neither built in nor
//!   registered with `Validator::extend(…)` is reported by the "unknown
//!   validation rule" inspection.
//! - **`requestField`**: the key of `$request->input('…')`, `query`,
//!   `string`, `validated('…')` and the like, completed with the fields of
//!   the Form Request's `rules()` (when the request is one) and of the
//!   rules validated in the same file, with goto to the rule entry.
//!
//! The context actions "Convert rule string to array" and "Convert all
//! rule strings to arrays" ([`PhpEngine::validation_intentions`]) rewrite
//! `'required|max:255'` as `['required', 'max:255']`.

use std::path::Path;
use std::sync::Arc;

use ide_core::TextEdit;

use super::{
    CallTarget, CalleePattern, PlacePattern, Position, RefContext, RefItem, ReferenceKind, Undefined, kind_of, sites,
};
use crate::engine::PhpEngine;
use crate::frameworks::laravel::validation::{
    Params, RULES, custom_rule_names, rule_array, rule_spec, segment_at, segments, unknown_rules,
};
use crate::imports::{ImportAction, REWRITE, file_edit};
use crate::navigate::Target;
use crate::syntax::ParsedFile;

/// A request: Laravel's, and so a Form Request.
const REQUEST: &[&str] = &["Illuminate\\Http\\Request"];
/// The validator factory: the `Validator` facade (and its global alias),
/// the factory and its contract.
const FACTORY: &[&str] = &[
    "Illuminate\\Support\\Facades\\Validator",
    "Validator",
    "Illuminate\\Validation\\Factory",
    "Illuminate\\Contracts\\Validation\\Factory",
];
/// A controller validating with the `ValidatesRequests` trait.
const CONTROLLER: &[&str] =
    &["Illuminate\\Routing\\Controller", "Illuminate\\Foundation\\Validation\\ValidatesRequests"];
const FORM_REQUEST: &str = "Illuminate\\Foundation\\Http\\FormRequest";

const VALIDATE: CalleePattern = CalleePattern::Method { classes: REQUEST, names: &["validate"] };
const VALIDATE_BAG: CalleePattern = CalleePattern::Method { classes: REQUEST, names: &["validateWithBag"] };
const MAKE: CalleePattern = CalleePattern::Method { classes: FACTORY, names: &["make", "validate"] };
const HELPER: CalleePattern = CalleePattern::Function("validator");
const CONTROLLER_VALIDATE: CalleePattern = CalleePattern::Method { classes: CONTROLLER, names: &["validate"] };
const CONTROLLER_BAG: CalleePattern = CalleePattern::Method { classes: CONTROLLER, names: &["validateWithBag"] };
const RULES_METHOD: CalleePattern = CalleePattern::Return { classes: &[FORM_REQUEST], names: &["rules"] };

/// The rules arrays: the call and the argument holding the array.
const RULE_ARRAYS: [PlacePattern; 7] = [
    PlacePattern::argument(VALIDATE, 0, "rules"),
    PlacePattern::argument(VALIDATE_BAG, 1, "rules"),
    PlacePattern::argument(MAKE, 1, "rules"),
    PlacePattern::argument(HELPER, 1, "rules"),
    PlacePattern::argument(CONTROLLER_VALIDATE, 1, "rules"),
    PlacePattern::argument(CONTROLLER_BAG, 2, "rules"),
    PlacePattern::argument(RULES_METHOD, 0, ""),
];

const fn values(array: [PlacePattern; 7]) -> [PlacePattern; 7] {
    let mut out = array;
    let mut i = 0;
    while i < out.len() {
        out[i] = out[i].at(Position::ArrayValue).nested();
        i += 1;
    }
    out
}

const fn keys(array: [PlacePattern; 7]) -> [PlacePattern; 7] {
    let mut out = array;
    let mut i = 0;
    while i < out.len() {
        out[i] = out[i].at(Position::ArrayKey);
        i += 1;
    }
    out
}

/// A rule: a value of a rules array, or of the array of a field's rules.
static RULE_PATTERNS: [PlacePattern; 7] = values(RULE_ARRAYS);
/// A field: a key of a rules array.
static FIELD_PATTERNS: [PlacePattern; 7] = keys(RULE_ARRAYS);

/// The request methods whose first parameter is a field.
const FIELD_METHODS: &[&str] = &[
    "input",
    "query",
    "post",
    "get",
    "string",
    "str",
    "integer",
    "float",
    "boolean",
    "date",
    "enum",
    "enums",
    "collect",
    "has",
    "hasAny",
    "filled",
    "anyFilled",
    "isNotFilled",
    "missing",
    "exists",
    "whenHas",
    "whenFilled",
    "file",
    "hasFile",
    "old",
    "only",
    "except",
    "validated",
];
const FIELD_LISTS: &[&str] = &["only", "except", "has", "hasAny", "filled", "anyFilled", "missing"];
const FIELD: CalleePattern = CalleePattern::Method { classes: REQUEST, names: FIELD_METHODS };
const FIELD_LIST: CalleePattern = CalleePattern::Method { classes: REQUEST, names: FIELD_LISTS };
static REQUEST_FIELD_PATTERNS: [PlacePattern; 2] =
    [PlacePattern::argument(FIELD, 0, "key"), PlacePattern::argument(FIELD_LIST, 0, "keys").at(Position::ListValue)];

/// See the module documentation.
pub struct ValidationRule;

/// See the module documentation.
pub struct RequestField;

/// The keys of rules arrays; not a kind of its own (keys aren't
/// references), only used to find the fields of a rules array.
struct RuleField;

impl ReferenceKind for RuleField {
    fn id(&self) -> &'static str {
        "ruleField"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &FIELD_PATTERNS
    }

    fn complete(&self, _: &RefContext<'_>, _: &str, _: usize) -> Vec<RefItem> {
        Vec::new()
    }

    fn resolve(&self, _: &RefContext<'_>, _: &str, _: usize) -> Vec<Target> {
        Vec::new()
    }

    fn is_known(&self, _: &RefContext<'_>, _: &str) -> bool {
        true
    }
}

/// A field of a rules array: its name, the file and the range of its key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuleFieldDecl {
    pub name: String,
    pub target: Target,
    /// The call the array is an argument of (or the `return`).
    pub call: u32,
}

impl PhpEngine {
    /// The parse of the file at `path`: its open buffer's, else the file's.
    pub(crate) fn file_parse(&self, path: &Path) -> Option<Arc<ParsedFile>> {
        if let Some(document) = self.open_documents().into_iter().find(|d| !d.embedded && d.path == path) {
            return Some(self.parse_open(&document));
        }
        let text = std::fs::read_to_string(path).ok()?;
        Some(Arc::new(ParsedFile::parse("file.php", text)))
    }

    /// The fields of the rules arrays of `parsed` (the file at `path`)
    /// that `keep` accepts the call of.
    fn rule_fields(&self, parsed: &ParsedFile, path: &Path, keep: &dyn Fn(&CallTarget) -> bool) -> Vec<RuleFieldDecl> {
        let resolver = self.resolver();
        let lines = parsed.line_index();
        sites(parsed, &resolver, &[&RuleField], None)
            .into_iter()
            .filter(|site| keep(&site.target) && FIELD_PATTERNS.iter().any(|pattern| pattern.matches(site, &resolver)))
            .filter(|site| !site.value.is_empty() && !site.value.contains(['$', '\\', '{']))
            .map(|site| RuleFieldDecl {
                name: site.value.clone(),
                target: Target { path: path.to_path_buf(), range: lines.range(site.start, site.end) },
                call: site.call,
            })
            .collect()
    }

    /// The fields the `rules()` of Form Request `class` (or a parent's)
    /// validates. Empty outside Laravel projects.
    pub fn laravel_form_request_fields(&self, class: &str) -> Vec<RuleFieldDecl> {
        let resolver = self.resolver();
        let Some(model) = resolver.class_model(class) else { return Vec::new() };
        if !model.is_subclass_of(FORM_REQUEST) {
            return Vec::new();
        }
        let mut owners = vec![model.fqn().to_owned()];
        owners.extend(model.parents.iter().cloned());
        for owner in owners {
            for target in self.class_targets(&owner) {
                let Some(parsed) = self.file_parse(&target.path) else { continue };
                let found = self.rule_fields(&parsed, &target.path, &|call| {
                    matches!(call, CallTarget::Return { class, method }
                        if crate::names::fqn_eq(crate::names::NameKind::ClassLike, class, &owner)
                            && method.eq_ignore_ascii_case("rules"))
                });
                if !found.is_empty() {
                    return found;
                }
            }
        }
        Vec::new()
    }

    /// The rules the project registers itself (`Validator::extend`).
    fn custom_validation_rules(&self) -> Vec<String> {
        let Some(index) = self.index() else { return Vec::new() };
        let Ok(files) = index.files_with_word("validator") else { return Vec::new() };
        let mut out = Vec::new();
        for path in files {
            if self.is_library(&path) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            out.extend(custom_rule_names(&text));
        }
        for document in self.open_documents() {
            out.extend(custom_rule_names(&document.text));
        }
        out.sort();
        out.dedup();
        out
    }

    /// The context actions on a rule string at bytes `start..end` of
    /// `parsed`: "Convert rule string to array" and "Convert all rule
    /// strings to arrays" (every rule string of its rules array).
    pub(crate) fn validation_intentions(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        start: u32,
        end: u32,
    ) -> Vec<ImportAction> {
        if self.ref_context().is_none() {
            return Vec::new();
        }
        let resolver = self.resolver();
        let text = parsed.text();
        let lines = parsed.line_index();
        // Rule strings that are a field's whole rules.
        let convertible: Vec<(u32, u32, u32, String)> = sites(parsed, &resolver, &[&ValidationRule], None)
            .into_iter()
            .filter(|site| {
                site.steps.len() == 1 && kind_of(site, &resolver).is_some_and(|k| k.id() == "validationRule")
            })
            .filter_map(|site| {
                let quote = text[site.start as usize - 1..].chars().next()?;
                let array = rule_array(&site.value, quote)?;
                Some((site.start - 1, site.end + 1, site.call, array))
            })
            .collect();
        let Some(at) = convertible.iter().find(|(from, to, _, _)| *from <= end && start <= *to) else {
            return Vec::new();
        };
        let edit = |edits: Vec<TextEdit>| file_edit(path, edits);
        let text_edit = |(from, to, _, array): &(u32, u32, u32, String)| TextEdit {
            range: lines.range(*from, *to),
            new_text: array.clone(),
        };
        let mut out = vec![ImportAction {
            title: "Convert rule string to array".to_owned(),
            kind: REWRITE,
            preferred: false,
            edit: edit(vec![text_edit(at)]),
        }];
        let all: Vec<TextEdit> = convertible.iter().filter(|site| site.2 == at.2).map(text_edit).collect();
        if all.len() > 1 {
            out.push(ImportAction {
                title: "Convert all rule strings to arrays".to_owned(),
                kind: REWRITE,
                preferred: false,
                edit: edit(all),
            });
        }
        out
    }
}

impl ValidationRule {
    /// The fields of the rules array the string at the context's site sits
    /// in (all of the file's when that array isn't found, as while typing).
    fn fields(cx: &RefContext<'_>) -> Vec<RuleFieldDecl> {
        let Some(site) = &cx.site else { return Vec::new() };
        let Some(parsed) = cx.engine.file_parse(&site.path) else { return Vec::new() };
        let all = cx.engine.rule_fields(&parsed, &site.path, &|_| true);
        let call = site.call.as_ref().map(|(_, call)| *call);
        let mine: Vec<RuleFieldDecl> = all.iter().filter(|field| Some(field.call) == call).cloned().collect();
        if mine.is_empty() { all } else { mine }
    }

    /// The tables the migrations create.
    fn tables(cx: &RefContext<'_>) -> Vec<String> {
        let facts = cx.engine.resolver().laravel();
        let mut out: Vec<String> = facts.tables.iter().map(|table| table.name.clone()).collect();
        out.sort();
        out.dedup();
        out
    }

    /// The items for parameter `index` of rule `name` (written `segment`).
    fn param_items(
        cx: &RefContext<'_>,
        spec: &crate::frameworks::laravel::validation::RuleSpec,
        segment: &crate::frameworks::laravel::validation::Segment<'_>,
        index: usize,
        (from, to): (usize, usize),
    ) -> Vec<RefItem> {
        let item = |label: String, detail: Option<String>| RefItem { insert: label.clone(), label, detail, from, to };
        let own = cx.site.as_ref().and_then(|site| site.key.clone());
        let field_items = || {
            let mut names: Vec<String> = Self::fields(cx)
                .into_iter()
                .map(|field| field.name)
                .filter(|name| Some(name) != own.as_ref())
                .collect();
            names.sort();
            names.dedup();
            names.into_iter().map(|name| item(name, Some("field".to_owned()))).collect()
        };
        match (spec.params, index) {
            (Params::Fields, _) | (Params::FirstField, 0) => field_items(),
            (Params::Table, 0) => Self::tables(cx).into_iter().map(|table| item(table, Some("table".into()))).collect(),
            (Params::Table, 1) => {
                let Some(table) = segment.param(0) else { return Vec::new() };
                let facts = cx.engine.resolver().laravel();
                facts
                    .columns(table)
                    .into_iter()
                    .map(|(_, column)| item(column.name.clone(), Some(column.ty.0.trim_start_matches('\\').to_owned())))
                    .collect()
            }
            _ => Vec::new(),
        }
    }
}

impl ReferenceKind for ValidationRule {
    fn id(&self) -> &'static str {
        "validationRule"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &RULE_PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<RefItem> {
        let Some(segment) = segment_at(value, at) else { return Vec::new() };
        if at <= segment.name_end {
            return RULES
                .iter()
                .map(|spec| {
                    let detail = (!spec.signature.is_empty()).then(|| format!("{}:{}", spec.name, spec.signature));
                    let insert = if spec.required && segment.params.is_none() {
                        format!("{}:", spec.name)
                    } else {
                        spec.name.to_owned()
                    };
                    RefItem { label: spec.name.to_owned(), insert, detail, from: segment.start, to: segment.name_end }
                })
                .collect();
        }
        let Some(spec) = rule_spec(segment.name) else { return Vec::new() };
        let Some((index, from, to)) = segment.param_at(at) else { return Vec::new() };
        Self::param_items(cx, spec, &segment, index, (from, to))
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<Target> {
        let Some(segment) = segment_at(value, at) else { return Vec::new() };
        let Some(spec) = rule_spec(segment.name) else { return Vec::new() };
        let Some((index, from, to)) = segment.param_at(at) else { return Vec::new() };
        let param = value[from..to].trim();
        match (spec.params, index) {
            (Params::Fields, _) | (Params::FirstField, 0) => {
                Self::fields(cx).into_iter().filter(|field| field.name == param).map(|field| field.target).collect()
            }
            (Params::Table, _) => {
                let Some(table) = segment.param(0) else { return Vec::new() };
                let facts = cx.engine.resolver().laravel();
                let columns = facts.columns(table);
                let found = if index == 0 {
                    columns.first().copied()
                } else {
                    columns.iter().find(|(_, column)| column.name == param).copied()
                };
                found
                    .and_then(|(migration, column)| {
                        Some(Target { path: migration.file.clone()?, range: column.loc.range })
                    })
                    .into_iter()
                    .collect()
            }
            _ => Vec::new(),
        }
    }

    fn usage_words(&self, value: &str) -> Vec<String> {
        crate::index::words(value)
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        unknown_rules(value, &cx.engine.custom_validation_rules()).is_empty()
    }

    fn hover(&self, _: &RefContext<'_>, value: &str) -> Option<String> {
        let lines: Vec<String> = segments(value)
            .into_iter()
            .filter_map(|segment| rule_spec(segment.name))
            .map(|spec| {
                if spec.signature.is_empty() {
                    format!("`{}`", spec.name)
                } else {
                    format!("`{}:{}`", spec.name, spec.signature)
                }
            })
            .collect();
        (!lines.is_empty()).then(|| format!("**validation rules**\n\n{}", lines.join("  \n")))
    }

    fn undefined(&self, cx: &RefContext<'_>, value: &str) -> Option<Undefined> {
        let unknown = unknown_rules(value, &cx.engine.custom_validation_rules());
        match unknown.as_slice() {
            [] => None,
            [one] => Some(Undefined::warning(format!("Unknown validation rule '{one}'"))),
            many => Some(Undefined::warning(format!(
                "Unknown validation rules {}",
                many.iter().map(|name| format!("'{name}'")).collect::<Vec<_>>().join(", ")
            ))),
        }
    }
}

impl RequestField {
    /// The fields the request at the context's site validates: its Form
    /// Request's, then those validated in the same file.
    fn fields(cx: &RefContext<'_>) -> Vec<RuleFieldDecl> {
        let Some(site) = &cx.site else { return Vec::new() };
        let mut out = Vec::new();
        if let Some((CallTarget::Method { classes, .. }, _)) = &site.call {
            for class in classes {
                out.extend(cx.engine.laravel_form_request_fields(class));
            }
        }
        if let Some(parsed) = cx.engine.file_parse(&site.path) {
            out.extend(cx.engine.rule_fields(&parsed, &site.path, &|call| !matches!(call, CallTarget::Return { .. })));
        }
        out
    }
}

impl ReferenceKind for RequestField {
    fn id(&self) -> &'static str {
        "requestField"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &REQUEST_FIELD_PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<RefItem> {
        let mut names: Vec<String> = Self::fields(cx).into_iter().map(|field| field.name).collect();
        names.dedup();
        names
            .into_iter()
            .map(|name| RefItem {
                label: name.clone(),
                insert: name,
                detail: Some("validated field".to_owned()),
                from: 0,
                to: value.len(),
            })
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        let mut out: Vec<Target> = Vec::new();
        for field in Self::fields(cx) {
            if field.name == value && !out.contains(&field.target) {
                out.push(field.target);
            }
        }
        out
    }

    fn is_known(&self, _: &RefContext<'_>, _: &str) -> bool {
        true
    }
}
