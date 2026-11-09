//! A live database schema as a source of table columns (Settings › PHP ›
//! Laravel › Database): the front end reads the tables and columns of the
//! chosen data source and gives them to the engine
//! ([`PhpEngine::set_live_schema`](crate::engine::PhpEngine::set_live_schema)).
//! They are merged into the [`LaravelFacts`] after the migrations, so the
//! database wins: a column's type and nullability are the database's, and
//! goto still opens the migration making the column when there is one.
//! Model attributes, the validation rules' `exists`/`unique` tables and
//! columns, and the query builder (`DB::table('…')`) all read the merged
//! columns.

use std::path::PathBuf;

use crate::summary::{Column, DocType, LaravelFacts, Loc, Table};

/// The tables of a data source, as the database reports them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LiveSchema {
    /// The data source's name, shown in hover.
    pub source: String,
    pub tables: Vec<LiveTable>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LiveTable {
    pub name: String,
    pub columns: Vec<LiveColumn>,
}

/// The length of a character type as the database names it
/// (`varchar(100)`, `character varying(50)`, `NVARCHAR(20)`).
fn sql_length(data_type: &str) -> Option<u32> {
    let lower = data_type.to_ascii_lowercase();
    let (name, rest) = lower.split_once('(')?;
    if !name.trim().ends_with("char") && !name.trim().ends_with("varying") {
        return None;
    }
    rest.split(')').next()?.trim().parse().ok()
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LiveColumn {
    pub name: String,
    /// The column's SQL type as the database names it (`varchar(255)`,
    /// `INTEGER`, `Nullable(Int32)`).
    pub data_type: String,
    pub nullable: bool,
}

impl LiveSchema {
    /// Appends the live tables to `facts` (after the migrations' tables, so
    /// their columns win in [`LaravelFacts::columns`]). A column some
    /// migration makes keeps that migration's file and location for goto;
    /// each live table becomes one [`Table`] per migration file its
    /// columns come from (and one for the columns no migration makes).
    pub fn merge_into(&self, facts: &mut LaravelFacts) {
        let mut added = Vec::new();
        for live in &self.tables {
            let known: Vec<(String, Option<PathBuf>, Loc)> = facts
                .columns(&live.name)
                .into_iter()
                .map(|(table, column)| (column.name.clone(), table.file.clone(), column.loc))
                .collect();
            let mut groups: Vec<(Option<PathBuf>, Vec<Column>)> = Vec::new();
            for column in &live.columns {
                let (php, nullable) = php_type(&column.data_type);
                let (file, loc) = known
                    .iter()
                    .find(|(name, _, _)| name.eq_ignore_ascii_case(&column.name))
                    .map(|(_, file, loc)| (file.clone(), *loc))
                    .unwrap_or_default();
                let column = Column {
                    name: column.name.clone(),
                    ty: DocType(php.to_owned()),
                    nullable: column.nullable || nullable,
                    length: sql_length(&column.data_type),
                    loc,
                };
                match groups.iter_mut().find(|(known, _)| *known == file) {
                    Some((_, columns)) => columns.push(column),
                    None => groups.push((file, vec![column])),
                }
            }
            if groups.is_empty() {
                groups.push((None, Vec::new()));
            }
            for (file, columns) in groups {
                added.push(Table {
                    name: live.name.clone(),
                    columns,
                    created: true,
                    partial: false,
                    file,
                    database: Some(self.source.clone()),
                    dropped: Vec::new(),
                    renamed: Vec::new(),
                });
            }
        }
        facts.tables.extend(added);
    }
}

/// The type a model attribute reading a column of SQL type `data_type`
/// has (before casts), and whether the type itself says the column is
/// nullable (ClickHouse's `Nullable(…)`). Integers are `int`, booleans
/// `bool`, floating-point numbers `float`; everything else (decimals,
/// dates, JSON, text) reads as a string, as PDO returns them.
pub fn php_type(data_type: &str) -> (&'static str, bool) {
    let lower = data_type.trim().to_ascii_lowercase();
    let (lower, nullable) = match lower.strip_prefix("nullable(").and_then(|rest| rest.strip_suffix(')')) {
        Some(inner) => (inner.to_owned(), true),
        None => (lower, false),
    };
    let lower = lower.strip_prefix("lowcardinality(").and_then(|rest| rest.strip_suffix(')')).unwrap_or(&lower);
    let base = lower.split(['(', ' ']).next().unwrap_or_default();
    let ty = if base.starts_with("bool") || base == "bit" {
        "bool"
    } else if (base.starts_with("int") && !base.starts_with("interval"))
        || base.starts_with("uint")
        || (base.ends_with("int") && !base.ends_with("point"))
        || base.ends_with("serial")
    {
        "int"
    } else if base.starts_with("float") || base.starts_with("double") || base == "real" {
        "float"
    } else {
        "string"
    };
    (ty, nullable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_sql_types_to_php_types() {
        let table = [
            ("INTEGER", "int"),
            ("bigint unsigned", "int"),
            ("tinyint(1)", "int"),
            ("int4", "int"),
            ("bigserial", "int"),
            ("UInt64", "int"),
            ("interval", "string"),
            ("point", "string"),
            ("boolean", "bool"),
            ("bool", "bool"),
            ("double precision", "float"),
            ("REAL", "float"),
            ("Float64", "float"),
            ("decimal(8,2)", "string"),
            ("varchar(255)", "string"),
            ("character varying", "string"),
            ("timestamp without time zone", "string"),
            ("json", "string"),
            ("TEXT", "string"),
        ];
        for (sql, php) in table {
            assert_eq!(php_type(sql), (php, false), "{sql}");
        }
        assert_eq!(php_type("Nullable(Int32)"), ("int", true));
        assert_eq!(php_type("LowCardinality(String)"), ("string", false));
    }

    fn column(name: &str, ty: &str, line: u32) -> Column {
        let mut loc = Loc::default();
        loc.range.start.line = line;
        Column { name: name.into(), ty: DocType(ty.into()), nullable: false, length: None, loc }
    }

    #[test]
    fn live_columns_win_and_keep_their_migrations() {
        let mut facts = LaravelFacts::default();
        facts.tables.push(Table {
            name: "posts".into(),
            columns: vec![column("id", "int", 1), column("title", "string", 2), column("draft", "bool", 3)],
            created: true,
            partial: true,
            file: Some(PathBuf::from("create_posts.php")),
            database: None,
            dropped: Vec::new(),
            renamed: Vec::new(),
        });
        let live = LiveSchema {
            source: "app".into(),
            tables: vec![
                LiveTable {
                    name: "posts".into(),
                    columns: vec![
                        LiveColumn { name: "id".into(), data_type: "INTEGER".into(), nullable: false },
                        LiveColumn { name: "title".into(), data_type: "TEXT".into(), nullable: true },
                        LiveColumn { name: "rating".into(), data_type: "REAL".into(), nullable: true },
                    ],
                },
                LiveTable { name: "audits".into(), columns: Vec::new() },
            ],
        };
        live.merge_into(&mut facts);
        let columns = facts.columns("posts");
        type Found<'a> = (&'a str, &'a str, bool, Option<&'a str>, Option<u32>);
        let found: Vec<Found<'_>> = columns
            .iter()
            .map(|(table, column)| {
                let line = table.file.as_ref().map(|_| column.loc.range.start.line);
                (column.name.as_str(), column.ty.0.as_str(), column.nullable, table.database.as_deref(), line)
            })
            .collect();
        assert_eq!(
            found,
            [
                ("id", "int", false, Some("app"), Some(1)),
                ("title", "string", true, Some("app"), Some(2)),
                // Only in a migration (not run yet): kept.
                ("draft", "bool", false, None, Some(3)),
                ("rating", "float", true, Some("app"), None),
            ]
        );
        // The database makes the schema certain, even of a partial migration.
        assert!(facts.schema_certain("posts") && facts.schema_certain("audits"));
        assert_eq!(columns[1].0.source_label(), "the database `app`");
        assert_eq!(columns[2].0.source_label(), "a migration");
    }
}
