//! How OpenIDEA's data sources look to the database tools: their DBMS and JDBC URL, the
//! schemas they show (the Schemas tab), the object kinds and objects of a schema, and an
//! object's structure as an indented text tree.
//!
//! The catalogs are read live, so every schema counts as introspected.

use ide_core::{IdeError, IdeResult};
use ide_db::{DataSource, DbDriver, DbManager, TableDetails};

/// A data source type: OpenIDEA's vendor preset (`DataSource::vendor`) and its names as a
/// JDBC driver (`create_database_connection`'s `dbms`) and as a DBMS.
pub struct Vendor {
    pub id: &'static str,
    /// The driver's name (`create_database_connection`'s `dbms`).
    pub driver_name: &'static str,
    pub dbms: &'static str,
    pub driver: DbDriver,
    /// JDBC URL scheme.
    pub scheme: &'static str,
}

/// OpenIDEA's data source types (`src/features/database/vendors.ts`).
pub const VENDORS: &[Vendor] = &[
    Vendor {
        id: "aurora-mysql",
        driver_name: "Amazon Aurora MySQL",
        dbms: "MySQL",
        driver: DbDriver::Mysql,
        scheme: "mysql",
    },
    Vendor {
        id: "redshift",
        driver_name: "Amazon Redshift",
        dbms: "Redshift",
        driver: DbDriver::Postgres,
        scheme: "redshift",
    },
    Vendor {
        id: "cockroachdb",
        driver_name: "CockroachDB",
        dbms: "CockroachDB",
        driver: DbDriver::Postgres,
        scheme: "postgresql",
    },
    Vendor {
        id: "greenplum",
        driver_name: "Greenplum",
        dbms: "Greenplum",
        driver: DbDriver::Postgres,
        scheme: "postgresql",
    },
    Vendor { id: "mariadb", driver_name: "MariaDB", dbms: "MariaDB", driver: DbDriver::Mysql, scheme: "mariadb" },
    Vendor {
        id: "sqlServer",
        driver_name: "Microsoft SQL Server",
        dbms: "Microsoft SQL Server",
        driver: DbDriver::SqlServer,
        scheme: "sqlserver",
    },
    Vendor { id: "mysql", driver_name: "MySQL", dbms: "MySQL", driver: DbDriver::Mysql, scheme: "mysql" },
    Vendor { id: "neon", driver_name: "Neon", dbms: "PostgreSQL", driver: DbDriver::Postgres, scheme: "postgresql" },
    Vendor {
        id: "oceanbase",
        driver_name: "OceanBase (MySQL mode)",
        dbms: "OceanBase",
        driver: DbDriver::Mysql,
        scheme: "oceanbase",
    },
    Vendor {
        id: "postgres",
        driver_name: "PostgreSQL",
        dbms: "PostgreSQL",
        driver: DbDriver::Postgres,
        scheme: "postgresql",
    },
    Vendor {
        id: "singlestore",
        driver_name: "SingleStore",
        dbms: "SingleStore",
        driver: DbDriver::Mysql,
        scheme: "singlestore",
    },
    Vendor { id: "sqlite", driver_name: "SQLite", dbms: "SQLite", driver: DbDriver::Sqlite, scheme: "sqlite" },
    Vendor {
        id: "supabase",
        driver_name: "Supabase",
        dbms: "PostgreSQL",
        driver: DbDriver::Postgres,
        scheme: "postgresql",
    },
    Vendor { id: "tidb", driver_name: "TiDB", dbms: "TiDB", driver: DbDriver::Mysql, scheme: "mysql" },
    Vendor {
        id: "timescaledb",
        driver_name: "TimescaleDB",
        dbms: "PostgreSQL",
        driver: DbDriver::Postgres,
        scheme: "postgresql",
    },
    Vendor {
        id: "yugabytedb",
        driver_name: "YugabyteDB",
        dbms: "YugabyteDB",
        driver: DbDriver::Postgres,
        scheme: "postgresql",
    },
];

/// The type of `source`: its preset, else its driver's own entry.
pub fn vendor_of(source: &DataSource) -> &'static Vendor {
    let own = |id: &str| VENDORS.iter().find(|v| v.id == id);
    own(&source.vendor).filter(|v| v.driver == source.driver).unwrap_or_else(|| {
        own(match source.driver {
            DbDriver::Sqlite => "sqlite",
            DbDriver::Postgres => "postgres",
            DbDriver::Mysql => "mysql",
            DbDriver::SqlServer => "sqlServer",
        })
        .expect("every driver has an entry")
    })
}

/// The JDBC URL of `source` without credentials.
pub fn jdbc_url(source: &DataSource) -> String {
    let vendor = vendor_of(source);
    if source.url_only && !source.url.trim().is_empty() {
        let url = source.url.trim();
        let url = if url.to_ascii_lowercase().starts_with("jdbc:") { url.to_owned() } else { format!("jdbc:{url}") };
        return sanitize_url(&url);
    }
    match source.driver {
        DbDriver::Sqlite => {
            format!(
                "jdbc:sqlite:{}",
                source.file.as_ref().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()
            )
        }
        DbDriver::SqlServer => {
            let port = source.port.map(|p| format!(":{p}")).unwrap_or_default();
            let mut url = format!("jdbc:sqlserver://{}{port}", source.host);
            if !source.database.is_empty() {
                url.push_str(&format!(";database={}", source.database));
            }
            url
        }
        _ => {
            let port = source.port.map(|p| format!(":{p}")).unwrap_or_default();
            format!("jdbc:{}://{}{port}/{}", vendor.scheme, source.host, source.database)
        }
    }
}

/// Drops the password of a URL's user info and its `password` parameters.
fn sanitize_url(url: &str) -> String {
    let (main, query) = match url.split_once('?') {
        Some((m, q)) => (m, Some(q)),
        None => (url, None),
    };
    let main = match main.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, path) = rest.split_once('/').map_or((rest, None), |(a, p)| (a, Some(p)));
            let authority = match authority.rsplit_once('@') {
                Some((user, host)) => format!("{}@{host}", user.split(':').next().unwrap_or_default()),
                None => authority.to_owned(),
            };
            match path {
                Some(p) => format!("{scheme}://{authority}/{p}"),
                None => format!("{scheme}://{authority}"),
            }
        }
        None => main.to_owned(),
    };
    // SQL Server style `;password=…` properties.
    let main: Vec<&str> = main.split(';').filter(|p| !p.to_ascii_lowercase().starts_with("password=")).collect();
    let main = main.join(";");
    match query {
        Some(q) => {
            let kept: Vec<&str> = q.split('&').filter(|p| !p.to_ascii_lowercase().starts_with("password=")).collect();
            if kept.is_empty() { main } else { format!("{main}?{}", kept.join("&")) }
        }
        None => main,
    }
}

// --- schemas ---------------------------------------------------------------------

/// A schema the data source shows, and the connection target to reach it with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Schema {
    /// The database it belongs to; empty when the DBMS has no databases above schemas.
    pub database: String,
    pub name: String,
    pub target: String,
}

impl Schema {
    /// The non-empty names joined with `.`.
    pub fn display_name(&self) -> String {
        display_name(&self.database, &self.name)
    }

    /// The schema's path (`DATABASE:db/SCHEMA:public`), as consent refusals name it.
    pub fn object_path(&self, driver: DbDriver) -> String {
        if has_databases(driver) {
            format!("DATABASE:{}/SCHEMA:{}", self.database, self.name)
        } else {
            format!("SCHEMA:{}", self.name)
        }
    }
}

pub fn display_name(database: &str, schema: &str) -> String {
    [database, schema].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(".")
}

/// Whether the DBMS has databases above schemas,
/// so a schema is named by `databaseName` and `schemaName`.
pub fn has_databases(driver: DbDriver) -> bool {
    matches!(driver, DbDriver::Postgres | DbDriver::SqlServer)
}

/// `*` / `?` wildcard match of the Schemas tab (case-sensitive).
fn matches_pattern(name: &str, pattern: &str) -> bool {
    if !pattern.contains(['*', '?']) {
        return name == pattern;
    }
    fn go(n: &[char], p: &[char]) -> bool {
        match p.first() {
            None => n.is_empty(),
            Some('*') => (0..=n.len()).any(|i| go(&n[i..], &p[1..])),
            Some('?') => !n.is_empty() && go(&n[1..], &p[1..]),
            Some(c) => n.first() == Some(c) && go(&n[1..], &p[1..]),
        }
    }
    go(&name.chars().collect::<Vec<_>>(), &pattern.chars().collect::<Vec<_>>())
}

/// The names the Schemas tab shows: all, or those matching a chosen name or pattern; `keep` always.
fn shown(names: Vec<String>, all: bool, chosen: &[String], keep: Option<&str>) -> Vec<String> {
    if all {
        return names;
    }
    let picks: Vec<&str> = chosen.iter().map(|p| p.trim()).filter(|p| !p.is_empty()).collect();
    names.into_iter().filter(|n| Some(n.as_str()) == keep || picks.iter().any(|p| matches_pattern(n, p))).collect()
}

/// The databases `source` shows, the connected one first, each with its connection target.
async fn databases(db: &DbManager, source: &DataSource) -> IdeResult<Vec<(String, String)>> {
    match source.driver {
        DbDriver::Postgres => {
            let all = db.databases(&source.id).await?;
            if source.options.single_database {
                return Ok(vec![(all.current.clone(), source.id.clone())]);
            }
            let i = &source.introspection;
            let mut names = shown(all.names, i.all_databases, &i.databases, Some(&all.current));
            // The connected database first.
            names.sort_by_key(|n| *n != all.current);
            Ok(names
                .into_iter()
                .map(|name| {
                    let target = if name == all.current { source.id.clone() } else { format!("{}:{name}", source.id) };
                    (name, target)
                })
                .collect())
        }
        DbDriver::SqlServer => {
            let pool = db.pool(&source.id).await?;
            let name = pool
                .rows("SELECT DB_NAME()", 1)
                .await?
                .into_iter()
                .next()
                .and_then(|r| r.into_iter().next().flatten())
                .unwrap_or_else(|| source.database.clone());
            Ok(vec![(name, source.id.clone())])
        }
        DbDriver::Mysql | DbDriver::Sqlite => Ok(vec![(String::new(), source.id.clone())]),
    }
}

/// The schemas of `target` the data source shows.
async fn schemas_of(db: &DbManager, source: &DataSource, target: &str) -> IdeResult<Vec<String>> {
    let i = &source.introspection;
    Ok(shown(db.schemas(target).await?, i.all_schemas, &i.schemas, None))
}

/// Every schema `source` shows. Databases other than the
/// connected one that cannot be read are left out.
pub async fn scoped_schemas(db: &DbManager, source: &DataSource) -> IdeResult<Vec<Schema>> {
    let mut out = Vec::new();
    for (i, (database, target)) in databases(db, source).await?.into_iter().enumerate() {
        let names = match schemas_of(db, source, &target).await {
            Ok(n) => n,
            Err(e) if i > 0 => {
                tracing::debug!("schemas of {target}: {}", e.message);
                continue;
            }
            Err(e) => return Err(e),
        };
        out.extend(names.into_iter().map(|name| Schema { database: database.clone(), name, target: target.clone() }));
    }
    Ok(out)
}

/// The schema named `database_name` / `schema_name`: names
/// match exactly; `database_name` is ignored where the DBMS has no databases.
pub async fn find_schema(
    db: &DbManager,
    source: &DataSource,
    database_name: &str,
    schema_name: &str,
) -> IdeResult<Schema> {
    let shown_name =
        if has_databases(source.driver) { display_name(database_name, schema_name) } else { schema_name.to_owned() };
    let not_found = || IdeError::not_found(format!("Schema {shown_name} is not found"));
    let database = databases(db, source)
        .await?
        .into_iter()
        .find(|(name, _)| !has_databases(source.driver) || name == database_name);
    let Some((database, target)) = database else { return Err(not_found()) };
    let names = schemas_of(db, source, &target).await?;
    if !names.iter().any(|n| n == schema_name) {
        return Err(not_found());
    }
    Ok(Schema { database, name: schema_name.to_owned(), target })
}

// --- objects ---------------------------------------------------------------------

/// The schema object kinds of `driver`, by code.
pub fn object_kinds(driver: DbDriver) -> &'static [&'static str] {
    match driver {
        DbDriver::Postgres => &["materialized-view", "routine", "sequence", "table", "view"],
        DbDriver::Mysql => &["routine", "table", "view"],
        DbDriver::Sqlite => &["table", "view"],
        DbDriver::SqlServer => &["routine", "sequence", "table", "view"],
    }
}

/// The name of a kind: its code with spaces (`materialized view`).
pub fn kind_name(code: &str) -> String {
    code.replace('-', " ")
}

/// Every object kind code, for telling an unknown code from a kind this DBMS lacks.
const ALL_KINDS: &[&str] = &[
    "database",
    "schema",
    "sequence",
    "cluster",
    "object-type",
    "collection-type",
    "table-type",
    "alias-type",
    "table",
    "materialized-log",
    "materialized-view",
    "view",
    "package",
    "body",
    "routine",
    "method",
    "operator",
    "object-attribute",
    "column",
    "index",
    "key",
    "foreign-key",
    "check",
    "default",
    "rule",
    "trigger",
    "argument",
    "variable",
    "synonym",
    "dblink",
    "virtual-table",
    "collation",
    "script",
    "tablespace",
    "data-file",
    "role",
    "database_role",
    "user",
    "connection",
    "foreign-data-wrapper",
    "server",
    "user-mapping",
    "foreign-function",
    "foreign-table",
    "external-schema",
    "external-database",
    "scheduled-event",
    "access-method",
    "aggregate",
    "exception",
    "extension",
    "projection",
    "macro",
    "partition",
    "warehouse",
    "format",
    "index-extension",
    "search-method",
    "constant",
    "period",
    "language",
    "login",
    "operator-class",
    "operator-family",
    "group",
    "security-policy",
    "security-predicate",
    "linked-server",
    "cast",
    "string",
    "list",
    "set",
    "sorted-set",
    "hash-table",
    "stream",
    "json_document",
    "data_structure",
    "collection",
    "column_master_key",
    "column_encryption_key",
    "column_encryption_key_value",
    "assembly",
    "datashare",
    "filegroup",
    "partition-function",
    "partition-scheme",
    "dynamic-table",
    "schema-object",
    "class",
    "class-instance",
    "redis-key",
    "unknown-object",
];

/// An exact (case-sensitive) kind code.
pub fn kind_or_fail(code: &str) -> IdeResult<&str> {
    if ALL_KINDS.contains(&code) { Ok(code) } else { Err(IdeError::invalid(format!("Unknown object kind: {code}"))) }
}

/// An object of a schema: its name and kind code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SchemaObject {
    pub name: String,
    pub kind: &'static str,
}

/// Schemas tab › Object filter: `name` matches one of its patterns (empty: all).
fn passes_object_filter(name: &str, filter: &str) -> bool {
    let patterns: Vec<String> =
        filter.split([',', ' ', '\t', '\n']).filter(|p| !p.is_empty()).map(str::to_lowercase).collect();
    patterns.is_empty() || patterns.iter().any(|p| matches_pattern(&name.to_lowercase(), p))
}

/// The objects of `schema`, of `kind` only when given.
pub async fn schema_objects(
    db: &DbManager,
    source: &DataSource,
    schema: &Schema,
    kind: Option<&str>,
) -> IdeResult<Vec<SchemaObject>> {
    let wants = |k: &str| kind.is_none_or(|w| w == k);
    let mut out = Vec::new();
    if ["table", "view", "materialized-view"].into_iter().any(wants) {
        for t in db.tables(&schema.target, &schema.name).await? {
            let k = match t.kind {
                ide_db::DbTableKind::Table => "table",
                ide_db::DbTableKind::View => "view",
                ide_db::DbTableKind::MaterializedView => "materialized-view",
            };
            if wants(k) {
                out.push(SchemaObject { name: t.name, kind: k });
            }
        }
    }
    if wants("routine") || wants("sequence") {
        let objects = db.schema_objects(&schema.target, &schema.name).await?;
        if wants("routine") {
            let mut seen = std::collections::HashSet::new();
            for r in objects.routines {
                // Overloads are one name.
                if seen.insert(r.name.clone()) {
                    out.push(SchemaObject { name: r.name, kind: "routine" });
                }
            }
        }
        if wants("sequence") {
            out.extend(objects.sequences.into_iter().map(|s| SchemaObject { name: s.name, kind: "sequence" }));
        }
    }
    out.retain(|o| passes_object_filter(&o.name, &source.introspection.object_filter));
    Ok(out)
}

/// The hierarchical descriptions of the objects of `kind` named `name` (case-insensitively)
/// in `schema`.
pub async fn describe(db: &DbManager, schema: &Schema, kind: &str, name: &str) -> IdeResult<Vec<String>> {
    let same = |n: &str| n.to_lowercase() == name.to_lowercase();
    let mut out = Vec::new();
    match kind {
        "table" | "view" | "materialized-view" => {
            for t in db.tables(&schema.target, &schema.name).await? {
                let k = match t.kind {
                    ide_db::DbTableKind::Table => "table",
                    ide_db::DbTableKind::View => "view",
                    ide_db::DbTableKind::MaterializedView => "materialized-view",
                };
                if k == kind && same(&t.name) {
                    let details = db.table_details(&schema.target, &schema.name, &t.name).await?;
                    out.push(describe_table(&t.name, &kind_name(k), &schema.name, &details));
                }
            }
        }
        "routine" => {
            for r in db.schema_objects(&schema.target, &schema.name).await?.routines {
                if same(&r.name) {
                    let what = match r.kind {
                        ide_db::DbObjectKind::Procedure => "procedure",
                        _ => "function",
                    };
                    let returns = r.returns.map(|t| format!(" returns {t}")).unwrap_or_default();
                    out.push(format!("{}: routine {what}({}){returns}\n", r.name, r.arguments));
                }
            }
        }
        "sequence" => {
            for s in db.schema_objects(&schema.target, &schema.name).await?.sequences {
                if same(&s.name) {
                    out.push(format!("{}: sequence {}\n", s.name, s.data_type).replace(" \n", "\n"));
                }
            }
        }
        _ => {}
    }
    Ok(out)
}

const INDENT: &str = "    ";

/// A table's (or view's) tree: its columns, foreign keys, indices, primary key and triggers.
pub fn describe_table(name: &str, kind: &str, schema: &str, d: &TableDetails) -> String {
    let mut out = format!("{name}: {kind}\n");
    let mut family = |title: &str, lines: Vec<String>| {
        if lines.is_empty() {
            return;
        }
        out.push_str(&format!("{INDENT}+ {title}\n"));
        for l in lines {
            out.push_str(&format!("{INDENT}{INDENT}{l}\n"));
        }
    };
    family(
        "columns",
        d.columns
            .iter()
            .map(|c| {
                let mut l = format!("{}: {}", c.name, c.data_type);
                if !c.nullable {
                    l.push_str(" NN");
                }
                if let Some(default) = &c.default {
                    l.push_str(&format!(" default {default}"));
                }
                l.trim_end().to_owned()
            })
            .collect(),
    );
    family(
        "foreign-keys",
        d.foreign_keys
            .iter()
            .enumerate()
            .map(|(i, k)| {
                let target = if k.ref_schema == schema {
                    k.ref_table.clone()
                } else {
                    format!("{}.{}", k.ref_schema, k.ref_table)
                };
                format!("#{}: foreign key ({}) -> {target} ({})", i + 1, k.columns.join(", "), k.ref_columns.join(", "))
            })
            .collect(),
    );
    family(
        "indices",
        d.indexes
            .iter()
            .map(|ix| {
                let unique = if ix.unique { "unique " } else { "" };
                format!("{}: {unique}({})", ix.name, ix.columns.join(", "))
            })
            .collect(),
    );
    let pk: Vec<&str> = d.columns.iter().filter(|c| c.primary_key).map(|c| c.name.as_str()).collect();
    family("keys", if pk.is_empty() { Vec::new() } else { vec![format!("#1: PK ({})", pk.join(", "))] });
    family(
        "triggers",
        d.triggers
            .iter()
            .map(|t| format!("{}: trigger {} {}", t.name, t.timing, t.events).trim_end().to_owned())
            .collect(),
    );
    out
}

/// A table-like object of `schema` named `name` case-insensitively: its real name.
pub async fn find_table(db: &DbManager, schema: &Schema, name: &str) -> IdeResult<Option<String>> {
    let lower = name.to_lowercase();
    let tables = db.tables(&schema.target, &schema.name).await?;
    Ok(tables
        .iter()
        .find(|t| t.name == name)
        .or_else(|| tables.iter().find(|t| t.name.to_lowercase() == lower))
        .map(|t| t.name.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_db::{ColumnInfo, ForeignKey, IndexInfo};

    #[test]
    fn jdbc_urls_leave_out_passwords() {
        let pg = DataSource {
            driver: DbDriver::Postgres,
            host: "db.local".into(),
            port: Some(5433),
            database: "app".into(),
            ..Default::default()
        };
        assert_eq!(jdbc_url(&pg), "jdbc:postgresql://db.local:5433/app");
        let url = DataSource {
            driver: DbDriver::Postgres,
            url_only: true,
            url: "postgresql://bob:secret@h:5432/app?sslmode=require&password=x".into(),
            ..Default::default()
        };
        assert_eq!(jdbc_url(&url), "jdbc:postgresql://bob@h:5432/app?sslmode=require");
        let lite = DataSource { driver: DbDriver::Sqlite, file: Some("/tmp/a.db".into()), ..Default::default() };
        assert_eq!(jdbc_url(&lite), "jdbc:sqlite:/tmp/a.db");
        let maria =
            DataSource { driver: DbDriver::Mysql, vendor: "mariadb".into(), host: "h".into(), ..Default::default() };
        assert_eq!(jdbc_url(&maria), "jdbc:mariadb://h/");
        assert_eq!(vendor_of(&maria).dbms, "MariaDB");
    }

    #[test]
    fn schema_names() {
        let s = Schema { database: "app".into(), name: "public".into(), target: "x".into() };
        assert_eq!(s.display_name(), "app.public");
        assert_eq!(s.object_path(DbDriver::Postgres), "DATABASE:app/SCHEMA:public");
        let m = Schema { database: String::new(), name: "shop".into(), target: "x".into() };
        assert_eq!(m.display_name(), "shop");
        assert_eq!(m.object_path(DbDriver::Mysql), "SCHEMA:shop");
    }

    #[test]
    fn schemas_tab_selection() {
        let names = || vec!["app".to_owned(), "app_test".to_owned(), "other".to_owned()];
        assert_eq!(shown(names(), true, &[], None).len(), 3);
        assert_eq!(shown(names(), false, &["app*".into()], None), vec!["app", "app_test"]);
        assert_eq!(shown(names(), false, &[], Some("other")), vec!["other"]);
        assert!(passes_object_filter("Users", "user?, orders"));
        assert!(!passes_object_filter("items", "user?, orders"));
    }

    #[test]
    fn kinds() {
        assert_eq!(kind_or_fail("materialized-view").unwrap(), "materialized-view");
        assert_eq!(kind_or_fail("Table").unwrap_err().message, "Unknown object kind: Table");
        assert_eq!(kind_or_fail("").unwrap_err().message, "Unknown object kind: ");
        assert_eq!(kind_name("materialized-view"), "materialized view");
    }

    #[test]
    fn describes_a_table_as_a_tree() {
        let col = |name: &str, ty: &str, nullable: bool, pk: bool| ColumnInfo {
            name: name.into(),
            data_type: ty.into(),
            nullable,
            default: None,
            primary_key: pk,
        };
        let d = TableDetails {
            columns: vec![col("folderId", "varchar(36)", false, true), col("tagId", "varchar(36)", false, true)],
            indexes: vec![IndexInfo {
                name: "#1".into(),
                unique: true,
                columns: vec!["folderId".into(), "tagId".into()],
            }],
            foreign_keys: vec![ForeignKey {
                schema: "main".into(),
                table: "folder_tag".into(),
                columns: vec!["folderId".into()],
                ref_schema: "main".into(),
                ref_table: "folder".into(),
                ref_columns: vec!["id".into()],
            }],
            triggers: vec![],
        };
        assert_eq!(
            describe_table("folder_tag", "table", "main", &d),
            "folder_tag: table
    + columns
        folderId: varchar(36) NN
        tagId: varchar(36) NN
    + foreign-keys
        #1: foreign key (folderId) -> folder (id)
    + indices
        #1: unique (folderId, tagId)
    + keys
        #1: PK (folderId, tagId)
"
        );
    }
}
