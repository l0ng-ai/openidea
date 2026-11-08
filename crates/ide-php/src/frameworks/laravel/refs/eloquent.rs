//! The `eloquentField` and `eloquentRelation` reference kinds, from the
//! model schema (migrations, casts, accessors and relations) that the
//! Laravel type provider knows ([`LaravelProvider`]):
//!
//! - **`eloquentField`**: a column of the model a query is about, in
//!   `where('…')` and its variants, `orderBy`, `latest`, `groupBy`,
//!   `select`, `pluck`, `value`, `increment` and the aggregates, and as a
//!   key of the attributes array of `create([...])`, `update([...])`,
//!   `fill`, `make`, `firstOrCreate`, `firstOrNew`, `updateOrCreate` and
//!   `where([...])`; also the entries of a model's `$fillable`, `$guarded`,
//!   `$hidden` and `$visible`, the keys of its `$casts` (or `casts()`), and
//!   the accessors its `$appends` names. The model is the receiver (a
//!   model class, `Builder<Post>`, a relation to it) or the class declaring
//!   the property. Completion offers the columns (with their types) and
//!   cast attributes; goto opens the column's migration, the cast or the
//!   accessor; hover describes them. A qualified `posts.title` names a
//!   column of that table, `options->theme` a JSON path in `options`, and
//!   `title as heading` a column under an alias. When the migrations say
//!   for certain which columns the table has
//!   ([`LaravelFacts::schema_certain`](crate::summary::LaravelFacts::schema_certain)),
//!   a name that is neither a column nor an attribute of the model is
//!   reported by the "unknown column" inspection.
//! - **`eloquentRelation`**: a relation of the model in `with('…')`,
//!   `load`, `loadMissing`, `has`, `whereHas`, `doesntHave`,
//!   `whereDoesntHave`, `withCount` and the like, nested with dots
//!   (`posts.comments`): each segment completes with the relations of the
//!   model the segments before it reach, and goes to its method. The keys
//!   of `with(['posts' => fn ($q) => …])` count too; the closure's `$q` is
//!   typed by the provider
//!   ([`TypeProvider::closure_parameters`](crate::types::provider::TypeProvider::closure_parameters)).
//!
//! The places follow Laravel's public query builder and Eloquent
//! documentation.

use super::controller_action::method_target;
use super::{CallTarget, CalleePattern, PlacePattern, Position, RefContext, RefItem, ReferenceKind, Undefined};
use crate::navigate::Target;
use crate::types::provider::{AttributeOrigin, LaravelProvider, MagicTarget};
use crate::types::{Context, Type};

pub(crate) const MODEL: &str = "Illuminate\\Database\\Eloquent\\Model";
const BUILDER: &str = "Illuminate\\Database\\Eloquent\\Builder";
const QUERY_BUILDER: &str = "Illuminate\\Database\\Query\\Builder";
const RELATION: &str = "Illuminate\\Database\\Eloquent\\Relations\\Relation";
const COLLECTION: &str = "Illuminate\\Database\\Eloquent\\Collection";

/// What queries a model (the model, its builder and its relations) or a
/// table (`DB::table('posts')`).
const QUERIES: &[&str] = &[MODEL, BUILDER, RELATION, QUERY_BUILDER];
/// What loads relations: the above and a collection of models.
const LOADS: &[&str] = &[MODEL, BUILDER, RELATION, COLLECTION];

/// Methods whose first argument is a column.
const COLUMN_FIRST: &[&str] = &[
    "where",
    "orWhere",
    "whereNot",
    "orWhereNot",
    "whereIn",
    "orWhereIn",
    "whereNotIn",
    "orWhereNotIn",
    "whereNull",
    "orWhereNull",
    "whereNotNull",
    "orWhereNotNull",
    "whereBetween",
    "orWhereBetween",
    "whereNotBetween",
    "orWhereNotBetween",
    "whereDate",
    "whereMonth",
    "whereDay",
    "whereYear",
    "whereTime",
    "whereLike",
    "orWhereLike",
    "whereColumn",
    "orWhereColumn",
    "firstWhere",
    "orderBy",
    "orderByDesc",
    "latest",
    "oldest",
    "pluck",
    "value",
    "increment",
    "decrement",
    "sum",
    "avg",
    "average",
    "min",
    "max",
];
/// Methods taking columns as their arguments, or a list of them.
const COLUMN_LISTS: &[&str] = &["select", "addSelect", "groupBy"];
/// Methods whose first argument is an attributes array.
const ATTRIBUTES_FIRST: &[&str] = &[
    "create",
    "forceCreate",
    "make",
    "update",
    "fill",
    "forceFill",
    "firstOrCreate",
    "firstOrNew",
    "updateOrCreate",
    "where",
    "orWhere",
    "insert",
    "insertOrIgnore",
    "insertGetId",
];
/// Methods whose second argument is an attributes array too.
const ATTRIBUTES_SECOND: &[&str] = &["firstOrCreate", "firstOrNew", "updateOrCreate"];

const COLUMN: CalleePattern = CalleePattern::Method { classes: QUERIES, names: COLUMN_FIRST };
const COLUMNS: CalleePattern = CalleePattern::Method { classes: QUERIES, names: COLUMN_LISTS };
const PLUCK_KEY: CalleePattern = CalleePattern::Method { classes: QUERIES, names: &["pluck"] };
const ATTRIBUTES: CalleePattern = CalleePattern::Method { classes: QUERIES, names: ATTRIBUTES_FIRST };
const ATTRIBUTES_TOO: CalleePattern = CalleePattern::Method { classes: QUERIES, names: ATTRIBUTES_SECOND };
const LISTS: CalleePattern =
    CalleePattern::Property { classes: &[MODEL], names: &["fillable", "guarded", "hidden", "visible", "appends"] };
const CASTS: CalleePattern = CalleePattern::Property { classes: &[MODEL], names: &["casts"] };
const CASTS_METHOD: CalleePattern = CalleePattern::Return { classes: &[MODEL], names: &["casts"] };

static FIELD_PATTERNS: [PlacePattern; 15] = [
    PlacePattern::argument(COLUMN, 0, "column"),
    PlacePattern::argument(COLUMNS, 0, "columns"),
    PlacePattern::argument(COLUMNS, 0, "columns").at(Position::ListValue),
    PlacePattern::argument(COLUMNS, 1, ""),
    PlacePattern::argument(COLUMNS, 2, ""),
    PlacePattern::argument(COLUMNS, 3, ""),
    PlacePattern::argument(COLUMNS, 4, ""),
    PlacePattern::argument(COLUMNS, 5, ""),
    PlacePattern::argument(PLUCK_KEY, 1, "key"),
    PlacePattern::argument(ATTRIBUTES, 0, "attributes").at(Position::ArrayKey),
    PlacePattern::argument(ATTRIBUTES_TOO, 1, "values").at(Position::ArrayKey),
    PlacePattern::argument(LISTS, 0, "").at(Position::ListValue),
    PlacePattern::argument(CASTS, 0, "").at(Position::ArrayKey),
    PlacePattern::argument(CASTS_METHOD, 0, "").at(Position::ArrayKey),
    // `orderBy('a')->orderBy('b')` is covered above; `whereColumn('a', 'b')`
    // compares two columns.
    PlacePattern::argument(CalleePattern::Method { classes: QUERIES, names: &["whereColumn", "orWhereColumn"] }, 2, ""),
];

/// Methods taking relations: as their arguments, a list, or the keys of an
/// array of closures.
const RELATION_METHODS: &[&str] = &[
    "with",
    "without",
    "withOnly",
    "load",
    "loadMissing",
    "loadCount",
    "withCount",
    "withExists",
    "withSum",
    "withAvg",
    "withMin",
    "withMax",
    "loadSum",
    "loadAvg",
    "loadMin",
    "loadMax",
    "has",
    "orHas",
    "doesntHave",
    "orDoesntHave",
    "whereHas",
    "orWhereHas",
    "whereDoesntHave",
    "orWhereDoesntHave",
    "withWhereHas",
    "whereRelation",
    "orWhereRelation",
    "whereBelongsTo",
];
/// Of those, the ones taking several relations as arguments.
const RELATION_VARIADIC: &[&str] = &["with", "without", "withOnly", "load", "loadMissing", "loadCount", "withCount"];

const RELATIONS: CalleePattern = CalleePattern::Method { classes: LOADS, names: RELATION_METHODS };
const RELATIONS_MORE: CalleePattern = CalleePattern::Method { classes: LOADS, names: RELATION_VARIADIC };

static RELATION_PATTERNS: [PlacePattern; 7] = [
    PlacePattern::argument(RELATIONS, 0, "relations"),
    PlacePattern::argument(RELATIONS, 0, "relations").at(Position::ListValue),
    PlacePattern::argument(RELATIONS, 0, "relations").at(Position::ArrayKey),
    PlacePattern::argument(RELATIONS, 0, "relation"),
    PlacePattern::argument(RELATIONS_MORE, 1, ""),
    PlacePattern::argument(RELATIONS_MORE, 2, ""),
    PlacePattern::argument(RELATIONS_MORE, 3, ""),
];

/// See the module documentation.
pub struct EloquentField;

/// See the module documentation.
pub struct EloquentRelation;

/// The model the string's site is about: the receiver's model class, else
/// the model its generic arguments name, else the class declaring the
/// property or method.
fn site_model(cx: &RefContext<'_>) -> Option<String> {
    let (target, _) = cx.site.as_ref()?.call.as_ref()?;
    let resolver = cx.engine.resolver();
    let is_model = |class: &str| resolver.class_model(class).filter(|model| model.is_subclass_of(MODEL));
    match target {
        CallTarget::Method { classes, models, .. } => classes
            .iter()
            .find_map(|class| is_model(class))
            .map(|model| model.fqn().to_owned())
            .or_else(|| models.first().cloned()),
        CallTarget::Property { class, .. } | CallTarget::Return { class, .. } => {
            is_model(class).map(|model| model.fqn().to_owned())
        }
        CallTarget::Function(_) => None,
    }
}

/// The table a query builder's site is about (`DB::table('posts')->where('…')`),
/// when it isn't about a model.
fn site_table(cx: &RefContext<'_>) -> Option<String> {
    match &cx.site.as_ref()?.call.as_ref()?.0 {
        CallTarget::Method { tables, .. } => tables.first().cloned(),
        _ => None,
    }
}

/// Whether the site is `$appends` (accessor names, not columns).
fn in_appends(cx: &RefContext<'_>) -> bool {
    matches!(
        cx.site.as_ref().and_then(|site| site.call.as_ref()),
        Some((CallTarget::Property { name, .. }, _)) if name.eq_ignore_ascii_case("appends")
    )
}

/// The parts of a column reference: the table it is qualified with, and
/// the byte range of the column name (`posts.title`, `options->theme`,
/// `title as heading`).
fn column_parts(value: &str) -> (Option<&str>, usize, usize) {
    let end = [value.find(" as "), value.find(" AS "), value.find("->"), value.find(' ')]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(value.len());
    let name = &value[..end];
    match name.rfind('.') {
        Some(dot) => (Some(&name[..dot]), dot + 1, end),
        None => (None, 0, end),
    }
}

/// An attribute of a model: a column or what the provider adds (casts,
/// accessors, relations, counts).
struct Attribute {
    name: String,
    detail: String,
    target: Option<Target>,
    /// A column of the table, or a cast attribute.
    stored: bool,
    accessor: bool,
}

fn attributes(cx: &RefContext<'_>, model: &str) -> Vec<Attribute> {
    let resolver = cx.engine.resolver();
    let mut out = Vec::new();
    let members = resolver.providers().magic_members(&Type::named(model), &resolver, &Context::default());
    for member in members {
        let MagicTarget::Attribute { class, ty, origin } = &member.target else { continue };
        let (target, stored, accessor) = match origin {
            AttributeOrigin::Column { source, .. } | AttributeOrigin::Cast { source, .. } => {
                (source.as_ref().map(|s| Target { path: s.file.clone(), range: s.loc.range }), true, false)
            }
            AttributeOrigin::Accessor { method } => (method_target(cx, class, method), false, true),
            AttributeOrigin::Relation { method } | AttributeOrigin::Count { method } => {
                (method_target(cx, class, method), false, false)
            }
            AttributeOrigin::Rule { .. } => continue,
        };
        out.push(Attribute { name: member.name.clone(), detail: ty.to_string(), target, stored, accessor });
    }
    out
}

impl EloquentField {
    /// The columns of `table` (not a model's): `(name, type, target)`.
    fn table_columns(cx: &RefContext<'_>, table: &str) -> Vec<(String, String, Option<Target>)> {
        let facts = cx.engine.resolver().laravel();
        facts
            .columns(table)
            .into_iter()
            .map(|(migration, column)| {
                let target = migration.file.clone().map(|path| Target { path, range: column.loc.range });
                (column.name.clone(), column.ty.0.trim_start_matches('\\').to_owned(), target)
            })
            .collect()
    }

    /// Whether `table` qualifying a column is the model's own table.
    fn own_table(cx: &RefContext<'_>, model: &str, table: &str) -> bool {
        LaravelProvider::model_table(&cx.engine.resolver(), model).is_some_and(|own| own.eq_ignore_ascii_case(table))
    }
}

impl ReferenceKind for EloquentField {
    fn id(&self) -> &'static str {
        "eloquentField"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &FIELD_PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<RefItem> {
        let (table, from, to) = column_parts(value);
        if at < from || at > to {
            return Vec::new();
        }
        let item =
            |label: String, detail: String| RefItem { insert: label.clone(), label, detail: Some(detail), from, to };
        let Some(model) = site_model(cx) else {
            let Some(table) = table.map(str::to_owned).or_else(|| site_table(cx)) else { return Vec::new() };
            return Self::table_columns(cx, &table).into_iter().map(|(name, ty, _)| item(name, ty)).collect();
        };
        if let Some(table) = table.filter(|table| !Self::own_table(cx, &model, table)) {
            return Self::table_columns(cx, table).into_iter().map(|(name, ty, _)| item(name, ty)).collect();
        }
        let appends = in_appends(cx);
        // The model's own lists and casts name its table's columns (the
        // casts being written aren't attributes yet).
        let own = matches!(
            cx.site.as_ref().and_then(|site| site.call.as_ref()),
            Some((CallTarget::Property { .. } | CallTarget::Return { .. }, _))
        );
        if own && !appends {
            let table = LaravelProvider::model_table(&cx.engine.resolver(), &model).unwrap_or_default();
            return Self::table_columns(cx, &table).into_iter().map(|(name, ty, _)| item(name, ty)).collect();
        }
        attributes(cx, &model)
            .into_iter()
            .filter(|attribute| if appends { attribute.accessor } else { attribute.stored })
            .map(|attribute| item(attribute.name, attribute.detail))
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        let (table, from, to) = column_parts(value);
        let name = &value[from..to];
        let Some(model) = site_model(cx) else {
            let Some(table) = table.map(str::to_owned).or_else(|| site_table(cx)) else { return Vec::new() };
            return Self::table_columns(cx, &table)
                .into_iter()
                .filter(|(column, _, _)| column == name)
                .filter_map(|(_, _, target)| target)
                .collect();
        };
        if let Some(table) = table.filter(|table| !Self::own_table(cx, &model, table)) {
            return Self::table_columns(cx, table)
                .into_iter()
                .filter(|(column, _, _)| column == name)
                .filter_map(|(_, _, target)| target)
                .collect();
        }
        attributes(cx, &model)
            .into_iter()
            .filter(|attribute| attribute.name == name)
            .filter_map(|attribute| attribute.target)
            .take(1)
            .collect()
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        self.undefined(cx, value).is_none()
    }

    fn hover(&self, cx: &RefContext<'_>, value: &str) -> Option<String> {
        let model = site_model(cx);
        let (table, from, to) = column_parts(value);
        let name = &value[from..to];
        let resolver = cx.engine.resolver();
        let table = match (table, &model) {
            (Some(table), _) => table.to_owned(),
            (None, Some(model)) => LaravelProvider::model_table(&resolver, model)?,
            (None, None) => site_table(cx)?,
        };
        let facts = resolver.laravel();
        let columns = facts.columns(&table);
        let (from, column) = columns.iter().find(|(_, column)| column.name == name)?;
        let nullable = if column.nullable { ", nullable" } else { "" };
        let mut out = format!(
            "Column `{name}` of table `{table}` (`{}`{nullable}), from {}",
            column.ty.0.trim_start_matches('\\'),
            from.source_label()
        );
        if let Some(model) = &model {
            let short = model.rsplit('\\').next().unwrap_or(model);
            out.push_str(&format!("\n\nModel `{short}`"));
        }
        Some(out)
    }

    fn undefined(&self, cx: &RefContext<'_>, value: &str) -> Option<Undefined> {
        if value.contains(['*', '(', '`', '"', ',']) {
            return None;
        }
        let Some(model) = site_model(cx) else {
            // `DB::table('posts')->where('…')`: the table's columns.
            let (qualified, from, to) = column_parts(value);
            let name = &value[from..to];
            let table = site_table(cx)?;
            if name.is_empty() || qualified.is_some_and(|q| !q.eq_ignore_ascii_case(&table)) {
                return None;
            }
            if !cx.engine.resolver().laravel().schema_certain(&table) {
                return None;
            }
            if Self::table_columns(cx, &table).iter().any(|(column, _, _)| column == name) {
                return None;
            }
            return Some(Undefined::warning(format!("Unknown column '{name}' of table '{table}'")));
        };
        let (table, from, to) = column_parts(value);
        let name = &value[from..to];
        if name.is_empty() || table.is_some_and(|table| !Self::own_table(cx, &model, table)) {
            return None;
        }
        let resolver = cx.engine.resolver();
        let table = LaravelProvider::model_table(&resolver, &model)?;
        if !resolver.laravel().schema_certain(&table) {
            return None;
        }
        let known = attributes(cx, &model).iter().any(|attribute| attribute.name == name)
            || resolver.class_model(&model).is_some_and(|class| class.property(name).is_some());
        if known {
            return None;
        }
        let what = if in_appends(cx) { "accessor" } else { "column" };
        let short = model.rsplit('\\').next().unwrap_or(&model);
        Some(Undefined::warning(format!("Unknown {what} '{name}' of model '{short}' (table '{table}')")))
    }
}

impl EloquentRelation {
    /// The segment of the dotted path `value` at byte `at`: its range, and
    /// the model the segments before it reach.
    fn segment(cx: &RefContext<'_>, value: &str, at: usize) -> Option<(usize, usize, String)> {
        let model = site_model(cx)?;
        // `posts:id,title`: the columns after `:` aren't relations.
        let path_end = value.find(':').unwrap_or(value.len());
        if at > path_end {
            return None;
        }
        let from = value[..at].rfind('.').map_or(0, |dot| dot + 1);
        let to = value[at..path_end].find('.').map_or(path_end, |dot| at + dot);
        let before = &value[..from.saturating_sub(1)];
        let reached = if before.is_empty() {
            model
        } else {
            LaravelProvider::relation_path_model(&cx.engine.resolver(), &model, before)?
        };
        Some((from, to, reached))
    }
}

impl ReferenceKind for EloquentRelation {
    fn id(&self) -> &'static str {
        "eloquentRelation"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &RELATION_PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<RefItem> {
        let Some((from, to, model)) = Self::segment(cx, value, at) else { return Vec::new() };
        LaravelProvider::model_relations(&cx.engine.resolver(), &model)
            .into_iter()
            .map(|relation| {
                let related = relation.related.as_deref().map(|class| class.rsplit('\\').next().unwrap_or(class));
                let detail = match (related, relation.many) {
                    (Some(related), true) => format!("{related}[]"),
                    (Some(related), false) => related.to_owned(),
                    (None, _) => "relation".to_owned(),
                };
                RefItem { label: relation.name.clone(), insert: relation.name, detail: Some(detail), from, to }
            })
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<Target> {
        let at = at.min(value.len());
        let Some((from, to, model)) = Self::segment(cx, value, at) else { return Vec::new() };
        let name = &value[from..to];
        LaravelProvider::model_relations(&cx.engine.resolver(), &model)
            .into_iter()
            .find(|relation| relation.name == name)
            .and_then(|relation| method_target(cx, &relation.class, &relation.name))
            .into_iter()
            .collect()
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        let Some(model) = site_model(cx) else { return true };
        let path = value.split(':').next().unwrap_or(value);
        LaravelProvider::relation_path_model(&cx.engine.resolver(), &model, path).is_some()
    }
}
