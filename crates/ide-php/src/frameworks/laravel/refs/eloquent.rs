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
//!
//!   The second argument of `whereRelation('comments', '…')` and of the
//!   aggregates (`withSum`, `withAvg`, `withMin`, `withMax` and their
//!   `load…` forms) is a column of the related model. A query builder
//!   remembers the tables it joins (`->join('users', …)`) and their
//!   aliases (`DB::table('posts as p')`): unqualified columns may be in any
//!   of them, `p.title` is in the table `p` stands for, and the columns of
//!   the `join()` call itself complete too. A `*_count` of any relation of
//!   the model isn't reported, as a `withCount` the inspection can't see (a
//!   scope, `$withCount`) may load it. Neither are unqualified names on a
//!   many-to-many or through relation (its query joins the pivot or
//!   intermediate table), nor names in `orderBy`, `groupBy`, `having` and
//!   the like, which may be aliases of the select list.
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
use crate::types::provider::laravel::{JOINS, snake};
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

/// Methods whose second argument is a column of the related model the
/// first one names (`whereRelation('comments', 'body', …)`,
/// `withSum('orders', 'total')`).
const RELATED_COLUMN: &[&str] = &[
    "whereRelation",
    "orWhereRelation",
    "withSum",
    "withAvg",
    "withMin",
    "withMax",
    "withAggregate",
    "loadSum",
    "loadAvg",
    "loadMin",
    "loadMax",
    "loadAggregate",
];

const RELATED: CalleePattern = CalleePattern::Method { classes: LOADS, names: RELATED_COLUMN };
const JOIN_COLUMNS: CalleePattern = CalleePattern::Method { classes: QUERIES, names: JOINS };

static FIELD_PATTERNS: [PlacePattern; 18] = [
    PlacePattern::argument(RELATED, 1, "column"),
    // `join('users', 'users.id', '=', 'posts.author_id')`.
    PlacePattern::argument(JOIN_COLUMNS, 1, "first"),
    PlacePattern::argument(JOIN_COLUMNS, 3, "second"),
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

/// The model whose columns the string names: the site's model
/// ([`site_model`]), or for the second argument of `whereRelation` and the
/// aggregates (`withSum('comments', '…')`) the model of the relation the
/// first one names.
fn query_model(cx: &RefContext<'_>) -> Option<String> {
    let model = site_model(cx)?;
    let site = cx.site.as_ref()?;
    match &site.call {
        Some((CallTarget::Method { name, .. }, _))
            if RELATED_COLUMN.iter().any(|known| known.eq_ignore_ascii_case(name)) =>
        {
            let (relation, _) = table_alias(site.first_argument.as_deref()?);
            LaravelProvider::relation_path_model(&cx.engine.resolver(), &model, relation)
        }
        _ => Some(model),
    }
}

/// A table with an optional alias, as a query names it: `posts as p` is
/// `("posts", Some("p"))`.
pub(crate) fn table_alias(spec: &str) -> (&str, Option<&str>) {
    match spec.to_ascii_lowercase().find(" as ") {
        Some(at) => (spec[..at].trim(), Some(spec[at + 4..].trim()).filter(|alias| !alias.is_empty())),
        None => (spec.trim(), None),
    }
}

/// The tables a query builder's site is about, with their aliases: the
/// table of `DB::table('posts as p')`, then those joined
/// (`->join('users', …)`). For a model's builder, only the joined ones.
fn site_tables(cx: &RefContext<'_>) -> Vec<(String, Option<String>)> {
    match cx.site.as_ref().and_then(|site| site.call.as_ref()) {
        Some((CallTarget::Method { tables, .. }, _)) => tables
            .iter()
            .map(|spec| {
                let (table, alias) = table_alias(spec);
                (table.to_owned(), alias.map(str::to_owned))
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// The table a qualifier names: the table it is the alias of in the
/// query, else itself (`users.email`).
fn qualified_table(cx: &RefContext<'_>, qualifier: &str) -> String {
    site_tables(cx)
        .into_iter()
        .find(|(_, alias)| alias.as_deref().is_some_and(|alias| alias.eq_ignore_ascii_case(qualifier)))
        .map_or_else(|| qualifier.to_owned(), |(table, _)| table)
}

/// Whether the site's call is on a many-to-many relation
/// (`BelongsToMany`, `MorphToMany`), which queries its pivot table too.
fn on_pivot(cx: &RefContext<'_>) -> bool {
    let Some((CallTarget::Method { classes, .. }, _)) = cx.site.as_ref().and_then(|site| site.call.as_ref()) else {
        return false;
    };
    let resolver = cx.engine.resolver();
    classes.iter().any(|class| {
        resolver.class_model(class).is_some_and(|model| {
            PIVOTED
                .iter()
                .any(|pivoted| model.is_subclass_of(&format!("Illuminate\\Database\\Eloquent\\Relations\\{pivoted}")))
        })
    })
}

/// The attributes a translatable model keeps in its translations table
/// (`$translatedAttributes`, astrotomic/laravel-translatable): the
/// strings of the property's default value.
fn translated_attributes(cx: &RefContext<'_>, model: &str) -> Vec<String> {
    let resolver = cx.engine.resolver();
    let Some(class) = resolver.class_model(model) else { return Vec::new() };
    let Some(default) = class
        .property("translatedAttributes")
        .and_then(|property| property.declared())
        .and_then(|property| property.default.clone())
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut rest = default.as_str();
    while let Some(start) = rest.find(['\'', '"']) {
        let quote = rest[start..].chars().next().unwrap_or('\'');
        let Some(end) = rest[start + 1..].find(quote) else { break };
        out.push(rest[start + 1..start + 1 + end].to_owned());
        rest = &rest[start + 2 + end..];
    }
    out
}

/// Whether the site is one of the model's own lists (`$guarded`,
/// `$hidden`, `$casts`).
fn in_model_list(cx: &RefContext<'_>) -> bool {
    matches!(
        cx.site.as_ref().and_then(|site| site.call.as_ref()),
        Some((CallTarget::Property { .. } | CallTarget::Return { .. }, _))
    )
}

/// Whether `name` is a method of the application's model `model`, or its
/// snake case (a relation as `toArray()` names it): the model's lists may
/// name those (`$guarded = ['shipping_address']`).
fn names_method(cx: &RefContext<'_>, model: &str, name: &str) -> bool {
    let resolver = cx.engine.resolver();
    resolver.class_model(model).is_some_and(|class| {
        class.methods.iter().any(|method| {
            !method.declaring.fqn.starts_with("Illuminate\\") && (method.name == name || snake(&method.name) == name)
        })
    })
}

/// Methods that may name an alias of the query's select list rather than
/// a column (`select(DB::raw('year(created_at) as year'))->orderBy('year')`).
const ALIAS_METHODS: &[&str] =
    &["orderBy", "orderByDesc", "latest", "oldest", "groupBy", "reorder", "having", "orHaving"];

/// Whether the site's call may name a select alias ([`ALIAS_METHODS`]):
/// the inspection leaves those alone.
fn names_select_alias(cx: &RefContext<'_>) -> bool {
    matches!(cx.site.as_ref().and_then(|site| site.call.as_ref()),
        Some((CallTarget::Method { name, .. }, _)) if ALIAS_METHODS.iter().any(|known| known.eq_ignore_ascii_case(name)))
}

/// Relations whose queries join a pivot table.
const PIVOTED: &[&str] = &["BelongsToMany", "MorphToMany", "HasManyThrough", "HasOneThrough"];

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
        let Some(model) = query_model(cx) else {
            if let Some(table) = table {
                let table = qualified_table(cx, table);
                return Self::table_columns(cx, &table).into_iter().map(|(name, ty, _)| item(name, ty)).collect();
            }
            // The columns of the table and of those joined, once each.
            let mut out: Vec<RefItem> = Vec::new();
            for (table, _) in site_tables(cx) {
                for (name, ty, _) in Self::table_columns(cx, &table) {
                    if !out.iter().any(|known| known.label == name) {
                        out.push(item(name, ty));
                    }
                }
            }
            return out;
        };
        if let Some(table) = table.filter(|table| !Self::own_table(cx, &model, table)) {
            let table = qualified_table(cx, table);
            return Self::table_columns(cx, &table).into_iter().map(|(name, ty, _)| item(name, ty)).collect();
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
        let mut out: Vec<RefItem> = attributes(cx, &model)
            .into_iter()
            .filter(|attribute| if appends { attribute.accessor } else { attribute.stored })
            .map(|attribute| item(attribute.name, attribute.detail))
            .collect();
        // The columns of the tables joined to the model's.
        if !appends {
            for (table, _) in site_tables(cx) {
                for (name, ty, _) in Self::table_columns(cx, &table) {
                    if !out.iter().any(|known| known.label == name) {
                        out.push(item(name, ty));
                    }
                }
            }
        }
        out
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        let (table, from, to) = column_parts(value);
        let name = &value[from..to];
        let in_table = |table: &str| -> Vec<Target> {
            Self::table_columns(cx, table)
                .into_iter()
                .filter(|(column, _, _)| column == name)
                .filter_map(|(_, _, target)| target)
                .collect()
        };
        let Some(model) = query_model(cx) else {
            if let Some(table) = table {
                return in_table(&qualified_table(cx, table));
            }
            return site_tables(cx)
                .into_iter()
                .map(|(table, _)| in_table(&table))
                .find(|found| !found.is_empty())
                .unwrap_or_default();
        };
        if let Some(table) = table.filter(|table| !Self::own_table(cx, &model, table)) {
            return in_table(&qualified_table(cx, table));
        }
        let found: Vec<Target> = attributes(cx, &model)
            .into_iter()
            .filter(|attribute| attribute.name == name)
            .filter_map(|attribute| attribute.target)
            .take(1)
            .collect();
        if !found.is_empty() || table.is_some() {
            return found;
        }
        site_tables(cx)
            .into_iter()
            .map(|(table, _)| in_table(&table))
            .find(|found| !found.is_empty())
            .unwrap_or_default()
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        self.undefined(cx, value).is_none()
    }

    fn hover(&self, cx: &RefContext<'_>, value: &str) -> Option<String> {
        let model = query_model(cx);
        let (table, from, to) = column_parts(value);
        let name = &value[from..to];
        let resolver = cx.engine.resolver();
        let facts = resolver.laravel();
        let has = |table: &str| facts.columns(table).iter().any(|(_, column)| column.name == name);
        let table = match (table, &model) {
            (Some(table), _) => qualified_table(cx, table),
            (None, Some(model)) => {
                let own = LaravelProvider::model_table(&resolver, model)?;
                if has(&own) {
                    own
                } else {
                    site_tables(cx).into_iter().map(|(table, _)| table).find(|table| has(table)).unwrap_or(own)
                }
            }
            (None, None) => {
                let tables: Vec<String> = site_tables(cx).into_iter().map(|(table, _)| table).collect();
                tables.iter().find(|table| has(table)).or(tables.first()).cloned()?
            }
        };
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
        if value.contains(['*', '(', '`', '"', ',']) || names_select_alias(cx) {
            return None;
        }
        // Every table the column may be in is known for certain, and none
        // has it.
        let missing = |tables: &[String], name: &str| {
            let facts = cx.engine.resolver().laravel();
            tables.iter().all(|table| facts.schema_certain(table))
                && !tables
                    .iter()
                    .any(|table| Self::table_columns(cx, table).iter().any(|(column, _, _)| column == name))
        };
        let Some(model) = query_model(cx) else {
            // `DB::table('posts')->where('…')`: the columns of the table
            // and of those joined, or of the table a qualifier names.
            let (qualified, from, to) = column_parts(value);
            let name = &value[from..to];
            let tables: Vec<String> = match qualified {
                Some(qualifier) => vec![qualified_table(cx, qualifier)],
                None => site_tables(cx).into_iter().map(|(table, _)| table).collect(),
            };
            if name.is_empty() || tables.is_empty() || !missing(&tables, name) {
                return None;
            }
            let listed = tables.iter().map(|table| format!("'{table}'")).collect::<Vec<_>>().join(", ");
            let what = if tables.len() == 1 { "table" } else { "tables" };
            return Some(Undefined::warning(format!("Unknown column '{name}' of {what} {listed}")));
        };
        let (qualifier, from, to) = column_parts(value);
        let name = &value[from..to];
        if name.is_empty() || qualifier.is_some_and(|table| !Self::own_table(cx, &model, table)) {
            return None;
        }
        let resolver = cx.engine.resolver();
        let table = LaravelProvider::model_table(&resolver, &model)?;
        if !resolver.laravel().schema_certain(&table) {
            return None;
        }
        // A `*_count` of a relation may come from a `withCount` the
        // inspection doesn't see (a scope, `$withCount`).
        let known = attributes(cx, &model).iter().any(|attribute| attribute.name == name)
            || resolver.class_model(&model).is_some_and(|class| class.property(name).is_some())
            || LaravelProvider::any_count_relation(&resolver, &model, name)
            || translated_attributes(cx, &model).iter().any(|attribute| attribute == name)
            || (in_model_list(cx) && names_method(cx, &model, name));
        if known {
            return None;
        }
        let joined: Vec<String> = site_tables(cx).into_iter().map(|(table, _)| table).collect();
        if qualifier.is_none() && !joined.is_empty() && !missing(&joined, name) {
            return None;
        }
        // A many-to-many relation's query joins its pivot table
        // (`withPivot('active')`), whose columns may be named unqualified.
        if qualifier.is_none() && on_pivot(cx) {
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
