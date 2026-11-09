//! The `dbTable` reference kind: the table of a query builder,
//! `DB::table('…')` (also on a connection, `DB::connection('x')->table('…')`).
//! Completion offers the tables the migrations and the live database
//! schema ([`super::super::database`]) know; hover lists a table's columns
//! and where they come from. The builder is typed `Query\Builder<'posts'>`
//! by the Laravel type provider, so the `eloquentField` places on it
//! (`where('…')`, `orderBy`, `insert([...])`) complete that table's columns.
//! The tables a query joins (`->join('users', …)`, on a query or an
//! Eloquent builder) are this kind too, and are remembered by the builder
//! the same way. A table may have an alias (`'posts as p'`): the kind is
//! about the table's part.

use super::eloquent::table_alias;
use super::{CalleePattern, PlacePattern, RefContext, RefItem, ReferenceKind};
use crate::navigate::Target;
use crate::types::provider::laravel::JOINS;

const TABLE: CalleePattern = CalleePattern::Method {
    classes: &[
        "Illuminate\\Support\\Facades\\DB",
        "Illuminate\\Database\\DatabaseManager",
        "Illuminate\\Database\\ConnectionInterface",
    ],
    names: &["table"],
};

const JOIN: CalleePattern = CalleePattern::Method {
    classes: &[
        "Illuminate\\Database\\Query\\Builder",
        "Illuminate\\Database\\Eloquent\\Builder",
        "Illuminate\\Database\\Eloquent\\Model",
        "Illuminate\\Database\\Eloquent\\Relations\\Relation",
    ],
    names: JOINS,
};

static PATTERNS: [PlacePattern; 2] =
    [PlacePattern::argument(TABLE, 0, "table"), PlacePattern::argument(JOIN, 0, "table")];

/// See the module documentation.
pub struct DbTable;

impl DbTable {
    /// The known tables (sorted, once each), with a detail: the number of
    /// columns and where they come from.
    fn tables(cx: &RefContext<'_>) -> Vec<(String, String)> {
        let facts = cx.engine.resolver().laravel();
        let mut names: Vec<&str> = facts.tables.iter().map(|table| table.name.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        names
            .into_iter()
            .map(|name| {
                let columns = facts.columns(name);
                let live = facts.tables.iter().any(|t| t.name == name && t.database.is_some());
                let from = if live { "database" } else { "migration" };
                (name.to_owned(), format!("{} columns · {from}", columns.len()))
            })
            .collect()
    }
}

impl ReferenceKind for DbTable {
    fn id(&self) -> &'static str {
        "dbTable"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<RefItem> {
        // `posts as p`: the table's part.
        let (table, _) = table_alias(value);
        let to = value.find(table).map_or(value.len(), |start| start + table.len());
        if at > to {
            return Vec::new();
        }
        Self::tables(cx)
            .into_iter()
            .map(|(name, detail)| RefItem { insert: name.clone(), label: name, detail: Some(detail), from: 0, to })
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        let (value, _) = table_alias(value);
        // The migration creating the table, at its first column.
        let facts = cx.engine.resolver().laravel();
        facts
            .tables
            .iter()
            .filter(|table| table.created && table.name == value)
            .find_map(|table| {
                let column = table.columns.first()?;
                Some(Target { path: table.file.clone()?, range: column.loc.range })
            })
            .into_iter()
            .collect()
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        let (value, _) = table_alias(value);
        cx.engine.resolver().laravel().tables.iter().any(|table| table.name == value)
    }

    fn hover(&self, cx: &RefContext<'_>, value: &str) -> Option<String> {
        let (value, _) = table_alias(value);
        let facts = cx.engine.resolver().laravel();
        let columns = facts.columns(value);
        if columns.is_empty() {
            return None;
        }
        let mut out = format!("Table `{value}`\n");
        for (table, column) in columns {
            let nullable = if column.nullable { ", nullable" } else { "" };
            out.push_str(&format!(
                "\n- `{}` `{}`{nullable}, from {}",
                column.name,
                column.ty.0.trim_start_matches('\\'),
                table.source_label()
            ));
        }
        Some(out)
    }
}
