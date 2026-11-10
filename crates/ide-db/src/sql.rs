//! SQL text generation per dialect: quoting, introspection queries, table
//! pages and row edits. Pure functions, so they are unit-tested without a server.

use crate::DbDriver;
use serde::{Deserialize, Serialize};
use specta::Type;

pub fn quote_ident(driver: DbDriver, name: &str) -> String {
    match driver {
        DbDriver::Clickhouse => format!("`{}`", name.replace('\\', "\\\\").replace('`', "\\`")),
        DbDriver::Mysql => format!("`{}`", name.replace('`', "``")),
        DbDriver::SqlServer => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

pub fn quote_literal(driver: DbDriver, value: &str) -> String {
    let mut s = value.replace('\'', "''");
    if matches!(driver, DbDriver::Mysql | DbDriver::Clickhouse) {
        s = s.replace('\\', "\\\\");
    }
    format!("'{s}'")
}

fn literal_or_null(driver: DbDriver, v: Option<&str>) -> String {
    v.map_or_else(|| "NULL".to_owned(), |v| quote_literal(driver, v))
}

pub fn qualified(driver: DbDriver, schema: &str, table: &str) -> String {
    if schema.is_empty() {
        quote_ident(driver, table)
    } else {
        format!("{}.{}", quote_ident(driver, schema), quote_ident(driver, table))
    }
}

/// PostgreSQL databases one can connect to; template databases only with `templates`.
pub fn databases(templates: bool) -> &'static str {
    if templates {
        "SELECT datname FROM pg_database WHERE datallowconn ORDER BY datname"
    } else {
        "SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname"
    }
}

/// Databases of managed services that their users cannot use (hidden unless connected to).
pub const INTERNAL_DATABASES: &[&str] = &["rdsadmin", "azure_maintenance", "azure_sys", "cloudsqladmin"];

/// Oracle system accounts hidden unless `show_system` (see the Schemas tab).
pub const ORACLE_SYSTEM_SCHEMAS: &[&str] = &[
    "CTXSYS",
    "DBSFWUSER",
    "DVSYS",
    "GSMADMIN_INTERNAL",
    "LBACSYS",
    "MDDATA",
    "MDSYS",
    "OLAPSYS",
    "OUTLN",
    "SYS",
    "SYSTEM",
    "XDB",
    "XS$NULL",
];

/// Databases available to this login; offline/restoring databases cannot be selected.
pub fn sqlserver_databases() -> &'static str {
    "SELECT name FROM sys.databases WHERE state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name"
}

pub fn schemas(driver: DbDriver, system: bool) -> &'static str {
    match driver {
        DbDriver::Sqlite => "SELECT name FROM pragma_database_list WHERE name <> 'temp' ORDER BY seq",
        DbDriver::Clickhouse if system => "SELECT name FROM system.databases ORDER BY name",
        DbDriver::Clickhouse => {
            "SELECT name FROM system.databases WHERE lower(name) NOT IN ('system', 'information_schema') ORDER BY name"
        }
        DbDriver::Postgres if system => {
            "SELECT schema_name FROM information_schema.schemata \
             WHERE schema_name NOT LIKE 'pg\\_toast%' AND schema_name NOT LIKE 'pg\\_temp%' ORDER BY 1"
        }
        DbDriver::Mysql if system => "SELECT schema_name FROM information_schema.schemata ORDER BY 1",
        DbDriver::SqlServer if system => "SELECT schema_name FROM information_schema.schemata ORDER BY 1",
        DbDriver::Oracle if system => "SELECT username FROM all_users ORDER BY username",
        DbDriver::Oracle => {
            "SELECT username FROM all_users WHERE username NOT IN \
             ('CTXSYS', 'DBSFWUSER', 'DVSYS', 'GSMADMIN_INTERNAL', 'LBACSYS', 'MDDATA', 'MDSYS', 'OLAPSYS', \
             'OUTLN', 'SYS', 'SYSTEM', 'XDB', 'XS$NULL') ORDER BY username"
        }
        DbDriver::Postgres => {
            "SELECT schema_name FROM information_schema.schemata \
             WHERE schema_name NOT IN ('pg_catalog', 'information_schema') \
             AND schema_name NOT LIKE 'pg\\_toast%' AND schema_name NOT LIKE 'pg\\_temp%' ORDER BY 1"
        }
        DbDriver::Mysql => {
            "SELECT schema_name FROM information_schema.schemata \
             WHERE schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') ORDER BY 1"
        }
        DbDriver::SqlServer => {
            "SELECT schema_name FROM information_schema.schemata \
             WHERE schema_name NOT IN ('sys', 'information_schema', 'guest') ORDER BY 1"
        }
    }
}

/// Rows: `name, kind` where kind is `table`, `view` or `materialized view`.
pub fn tables(driver: DbDriver, schema: &str) -> String {
    match driver {
        DbDriver::Clickhouse => format!(
            "SELECT name, CASE engine WHEN 'View' THEN 'view' WHEN 'MaterializedView' THEN 'materialized view' \
             WHEN 'WindowView' THEN 'view' ELSE 'table' END FROM system.tables \
             WHERE database = {} AND is_temporary = 0 ORDER BY name",
            quote_literal(driver, schema)
        ),
        DbDriver::Sqlite => format!(
            "SELECT name, type FROM {}.sqlite_master WHERE type IN ('table', 'view') \
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
            quote_ident(driver, schema)
        ),
        DbDriver::Oracle => format!(
            "SELECT table_name, 'table' FROM all_tables WHERE owner = {} \
             UNION ALL SELECT view_name, 'view' FROM all_views WHERE owner = {} ORDER BY 1",
            quote_literal(driver, schema),
            quote_literal(driver, schema)
        ),
        DbDriver::Postgres => format!(
            "SELECT c.relname, CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = {} AND c.relkind IN ('r', 'v', 'm', 'p', 'f') ORDER BY 1",
            quote_literal(driver, schema)
        ),
        DbDriver::Mysql => format!(
            "SELECT table_name, CASE WHEN table_type LIKE '%VIEW%' THEN 'view' ELSE 'table' END \
             FROM information_schema.tables WHERE table_schema = {} ORDER BY 1",
            quote_literal(driver, schema)
        ),
        DbDriver::SqlServer => format!(
            "SELECT table_name, CASE WHEN table_type LIKE '%VIEW%' THEN 'view' ELSE 'table' END \
             FROM information_schema.tables WHERE table_schema = {} ORDER BY 1",
            quote_literal(driver, schema)
        ),
    }
}

/// Rows: `name, type, nullable (YES/NO or 0/1), default, is_pk (0/1)`.
pub fn columns(driver: DbDriver, schema: &str, table: &str) -> String {
    let (s, t) = (quote_literal(driver, schema), quote_literal(driver, table));
    match driver {
        DbDriver::Clickhouse => format!(
            "SELECT name, type, CASE WHEN startsWith(type, 'Nullable(') \
             OR startsWith(type, 'LowCardinality(Nullable(') THEN 'YES' ELSE 'NO' END, \
             if(default_kind = '', NULL, default_expression), is_in_primary_key \
             FROM system.columns WHERE database = {s} AND table = {t} ORDER BY position"
        ),
        DbDriver::Sqlite => format!(
            "SELECT name, type, CASE WHEN \"notnull\" = 0 THEN 'YES' ELSE 'NO' END, dflt_value, \
             CASE WHEN pk > 0 THEN 1 ELSE 0 END FROM pragma_table_info({t}, {s}) ORDER BY cid"
        ),
        DbDriver::Postgres => format!(
            "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, \
             CASE WHEN EXISTS (SELECT 1 FROM information_schema.table_constraints tc \
               JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name \
               AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name \
               WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema \
               AND tc.table_name = c.table_name AND k.column_name = c.column_name) THEN 1 ELSE 0 END \
             FROM information_schema.columns c WHERE c.table_schema = {s} AND c.table_name = {t} \
             ORDER BY c.ordinal_position"
        ),
        DbDriver::Mysql => format!(
            "SELECT column_name, column_type, is_nullable, column_default, \
             CASE WHEN column_key = 'PRI' THEN 1 ELSE 0 END \
             FROM information_schema.columns WHERE table_schema = {s} AND table_name = {t} \
             ORDER BY ordinal_position"
        ),
        DbDriver::SqlServer => format!(
            "SELECT column_name, data_type, is_nullable, column_default, \
             CASE WHEN EXISTS (SELECT 1 FROM information_schema.table_constraints tc \
               JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name \
               AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name \
               WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = {s} \
               AND tc.table_name = {t} AND k.column_name = c.column_name) THEN 1 ELSE 0 END \
             FROM information_schema.columns c WHERE c.table_schema = {s} AND c.table_name = {t} \
             ORDER BY c.ordinal_position"
        ),
        DbDriver::Oracle => format!(
            "SELECT c.column_name, c.data_type, DECODE(c.nullable, 'Y', 'YES', 'NO'), c.data_default, \
             CASE WHEN k.column_name IS NOT NULL THEN 1 ELSE 0 END \
             FROM all_tab_columns c \
             LEFT JOIN (SELECT kc.column_name FROM all_constraints con \
               JOIN all_cons_columns kc ON kc.owner = con.owner AND kc.table_name = con.table_name \
               AND kc.constraint_name = con.constraint_name \
               WHERE con.constraint_type = 'P' AND con.owner = {s} AND con.table_name = {t}) k \
             ON k.column_name = c.column_name \
             WHERE c.owner = {s} AND c.table_name = {t} ORDER BY c.column_id"
        ),
    }
}

/// Rows: `index name, unique (0/1), column` (one row per indexed column, in order).
pub fn indexes(driver: DbDriver, schema: &str, table: &str) -> String {
    let (s, t) = (quote_literal(driver, schema), quote_literal(driver, table));
    match driver {
        DbDriver::Clickhouse => format!(
            "SELECT * FROM (SELECT 'PRIMARY KEY' AS index_name, 0 AS is_unique, primary_key AS expression \
             FROM system.tables WHERE database = {s} AND name = {t} AND primary_key != '' \
             UNION ALL SELECT name, 0, expr FROM system.data_skipping_indices \
             WHERE database = {s} AND table = {t}) ORDER BY index_name"
        ),
        DbDriver::Sqlite => format!(
            "SELECT il.name, il.\"unique\", ii.name FROM pragma_index_list({t}, {s}) il \
             JOIN pragma_index_info(il.name, {s}) ii ORDER BY il.name, ii.seqno"
        ),
        DbDriver::Postgres => format!(
            "SELECT i.relname, CASE WHEN ix.indisunique THEN 1 ELSE 0 END, a.attname \
             FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true \
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum \
             WHERE n.nspname = {s} AND t.relname = {t} ORDER BY i.relname, k.ord"
        ),
        DbDriver::Mysql => format!(
            "SELECT index_name, CASE WHEN non_unique = 0 THEN 1 ELSE 0 END, column_name \
             FROM information_schema.statistics WHERE table_schema = {s} AND table_name = {t} \
             ORDER BY index_name, seq_in_index"
        ),
        DbDriver::SqlServer => format!(
            "SELECT i.name, CASE WHEN i.is_unique = 1 THEN 1 ELSE 0 END, c.name \
             FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
             WHERE OBJECT_SCHEMA_NAME(i.object_id) = {s} AND OBJECT_NAME(i.object_id) = {t} AND i.name IS NOT NULL \
             ORDER BY i.name, ic.key_ordinal"
        ),
        DbDriver::Oracle => format!(
            "SELECT i.index_name, CASE WHEN i.uniqueness = 'UNIQUE' THEN 1 ELSE 0 END, ic.column_name \
             FROM all_indexes i JOIN all_ind_columns ic \
             ON ic.index_owner = i.owner AND ic.index_name = i.index_name \
             WHERE i.owner = {s} AND i.table_name = {t} ORDER BY i.index_name, ic.column_position"
        ),
    }
}

/// Rows: `schema, table, kind (table/view), column, type, nullable (YES/NO), is_pk (0/1), has_default (0/1)`
/// for SQL completion, grouped by table in column order.
pub fn completion_columns(driver: DbDriver) -> &'static str {
    match driver {
        DbDriver::Clickhouse => {
            "SELECT c.database, c.table, CASE t.engine WHEN 'View' THEN 'view' \
             WHEN 'MaterializedView' THEN 'materialized view' WHEN 'WindowView' THEN 'view' ELSE 'table' END, \
             c.name, c.type, CASE WHEN startsWith(c.type, 'Nullable(') \
             OR startsWith(c.type, 'LowCardinality(Nullable(') THEN 'YES' ELSE 'NO' END, c.is_in_primary_key, 1 \
             FROM system.columns c JOIN system.tables t ON t.database = c.database AND t.name = c.table \
             WHERE lower(c.database) NOT IN ('system', 'information_schema') AND t.is_temporary = 0 \
             ORDER BY c.database, c.table, c.position LIMIT 50000"
        }
        DbDriver::Sqlite => {
            "SELECT 'main', m.name, m.type, p.name, p.type, CASE WHEN p.\"notnull\" = 0 THEN 'YES' ELSE 'NO' END, \
             CASE WHEN p.pk > 0 THEN 1 ELSE 0 END, \
             CASE WHEN p.dflt_value IS NOT NULL THEN 1 \
             WHEN p.pk = 1 AND upper(p.type) = 'INTEGER' \
             AND (SELECT count(*) FROM pragma_table_info(m.name) k WHERE k.pk > 0) = 1 THEN 1 ELSE 0 END \
             FROM sqlite_master m JOIN pragma_table_info(m.name) p \
             WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY m.name, p.cid"
        }
        DbDriver::Postgres => {
            "SELECT n.nspname, c.relname, CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END, a.attname, \
             format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END, \
             CASE WHEN EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary \
               AND a.attnum = ANY(i.indkey)) THEN 1 ELSE 0 END, \
             CASE WHEN a.atthasdef OR a.attidentity <> '' THEN 1 ELSE 0 END \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid \
             WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f') AND a.attnum > 0 AND NOT a.attisdropped \
             AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
             AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%' \
             ORDER BY n.nspname, c.relname, a.attnum LIMIT 50000"
        }
        DbDriver::Mysql => {
            "SELECT c.table_schema, c.table_name, CASE WHEN t.table_type LIKE '%VIEW%' THEN 'view' ELSE 'table' END, \
             c.column_name, c.column_type, c.is_nullable, CASE WHEN c.column_key = 'PRI' THEN 1 ELSE 0 END, \
             CASE WHEN c.column_default IS NOT NULL OR c.extra LIKE '%auto_increment%' THEN 1 ELSE 0 END \
             FROM information_schema.columns c JOIN information_schema.tables t \
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name \
             WHERE c.table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') \
             ORDER BY c.table_schema, c.table_name, c.ordinal_position LIMIT 50000"
        }
        DbDriver::SqlServer => {
            "SELECT c.table_schema, c.table_name, CASE WHEN t.table_type LIKE '%VIEW%' THEN 'view' ELSE 'table' END, \
             c.column_name, c.data_type, c.is_nullable, \
             CASE WHEN EXISTS (SELECT 1 FROM information_schema.table_constraints tc \
               JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name \
               AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name \
               WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema \
               AND tc.table_name = c.table_name AND k.column_name = c.column_name) THEN 1 ELSE 0 END, \
             CASE WHEN c.column_default IS NOT NULL THEN 1 ELSE 0 END \
             FROM information_schema.columns c JOIN information_schema.tables t \
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name \
             WHERE c.table_schema NOT IN ('sys', 'information_schema') \
             ORDER BY c.table_schema, c.table_name, c.ordinal_position"
        }
        DbDriver::Oracle => {
            "SELECT c.owner, c.table_name, CASE WHEN v.view_name IS NOT NULL THEN 'view' ELSE 'table' END, \
             c.column_name, c.data_type, DECODE(c.nullable, 'Y', 'YES', 'NO'), \
             CASE WHEN k.column_name IS NOT NULL THEN 1 ELSE 0 END, \
             CASE WHEN c.data_default IS NOT NULL THEN 1 ELSE 0 END \
             FROM all_tab_columns c \
             LEFT JOIN all_views v ON v.owner = c.owner AND v.view_name = c.table_name \
             LEFT JOIN (SELECT con.owner, con.table_name, kc.column_name FROM all_constraints con \
               JOIN all_cons_columns kc ON kc.owner = con.owner AND kc.table_name = con.table_name \
               AND kc.constraint_name = con.constraint_name WHERE con.constraint_type = 'P') k \
             ON k.owner = c.owner AND k.table_name = c.table_name AND k.column_name = c.column_name \
             WHERE c.owner NOT IN ('CTXSYS', 'DBSFWUSER', 'DVSYS', 'GSMADMIN_INTERNAL', 'LBACSYS', 'MDDATA', \
             'MDSYS', 'OLAPSYS', 'OUTLN', 'SYS', 'SYSTEM', 'XDB', 'XS$NULL') \
             ORDER BY c.owner, c.table_name, c.column_id FETCH FIRST 50000 ROWS ONLY"
        }
    }
}

/// Rows: `schema, table, constraint, column, ref schema, ref table, ref column`
/// (one row per column pair, in key order). SQLite leaves the ref column NULL
/// when the key references the primary key implicitly.
pub fn foreign_keys(driver: DbDriver) -> &'static str {
    match driver {
        DbDriver::Clickhouse => "SELECT '', '', '', '', '', '', '' WHERE 0",
        DbDriver::Sqlite => {
            "SELECT 'main', m.name, f.id, f.\"from\", 'main', f.\"table\", f.\"to\" \
             FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f \
             WHERE m.type = 'table' ORDER BY m.name, f.id, f.seq"
        }
        DbDriver::Postgres => {
            "SELECT sn.nspname, sc.relname, con.conname, sa.attname, tn.nspname, tc.relname, ta.attname \
             FROM pg_constraint con \
             JOIN pg_class sc ON sc.oid = con.conrelid JOIN pg_namespace sn ON sn.oid = sc.relnamespace \
             JOIN pg_class tc ON tc.oid = con.confrelid JOIN pg_namespace tn ON tn.oid = tc.relnamespace \
             CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(s, t, ord) \
             JOIN pg_attribute sa ON sa.attrelid = sc.oid AND sa.attnum = k.s \
             JOIN pg_attribute ta ON ta.attrelid = tc.oid AND ta.attnum = k.t \
             WHERE con.contype = 'f' AND sn.nspname NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY 1, 2, 3, k.ord LIMIT 20000"
        }
        DbDriver::Mysql => {
            "SELECT table_schema, table_name, constraint_name, column_name, \
             referenced_table_schema, referenced_table_name, referenced_column_name \
             FROM information_schema.key_column_usage WHERE referenced_table_name IS NOT NULL \
             AND table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') \
             ORDER BY table_schema, table_name, constraint_name, ordinal_position LIMIT 20000"
        }
        DbDriver::SqlServer => {
            "SELECT table_schema, table_name, constraint_name, column_name, \
             referenced_table_schema, referenced_table_name, referenced_column_name \
             FROM information_schema.key_column_usage WHERE referenced_table_name IS NOT NULL \
             AND table_schema NOT IN ('sys', 'information_schema') \
             ORDER BY table_schema, table_name, constraint_name, ordinal_position"
        }
        DbDriver::Oracle => {
            "SELECT con.owner, con.table_name, con.constraint_name, col.column_name, \
             rcon.owner, rcon.table_name, rcol.column_name \
             FROM all_constraints con \
             JOIN all_cons_columns col ON col.owner = con.owner AND col.table_name = con.table_name \
             AND col.constraint_name = con.constraint_name \
             JOIN all_constraints rcon ON rcon.owner = con.r_owner AND rcon.constraint_name = con.r_constraint_name \
             JOIN all_cons_columns rcol ON rcol.owner = rcon.owner AND rcol.table_name = rcon.table_name \
             AND rcol.constraint_name = rcon.constraint_name \
             WHERE con.constraint_type = 'R' AND con.owner NOT IN ('CTXSYS', 'DBSFWUSER', 'DVSYS', \
             'GSMADMIN_INTERNAL', 'LBACSYS', 'MDDATA', 'MDSYS', 'OLAPSYS', 'OUTLN', 'SYS', 'SYSTEM', 'XDB', 'XS$NULL') \
             ORDER BY 1, 2, 3, col.position FETCH FIRST 20000 ROWS ONLY"
        }
    }
}

/// [`foreign_keys`] rows of one table.
pub fn table_foreign_keys(driver: DbDriver, schema: &str, table: &str) -> String {
    let (s, t) = (quote_literal(driver, schema), quote_literal(driver, table));
    match driver {
        DbDriver::Clickhouse => foreign_keys(driver).to_owned(),
        DbDriver::Sqlite => format!(
            "SELECT {s}, {t}, f.id, f.\"from\", {s}, f.\"table\", f.\"to\"              FROM pragma_foreign_key_list({t}, {s}) f ORDER BY f.id, f.seq"
        ),
        DbDriver::Postgres => format!(
            "SELECT sn.nspname, sc.relname, con.conname, sa.attname, tn.nspname, tc.relname, ta.attname              FROM pg_constraint con              JOIN pg_class sc ON sc.oid = con.conrelid JOIN pg_namespace sn ON sn.oid = sc.relnamespace              JOIN pg_class tc ON tc.oid = con.confrelid JOIN pg_namespace tn ON tn.oid = tc.relnamespace              CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(s, t, ord)              JOIN pg_attribute sa ON sa.attrelid = sc.oid AND sa.attnum = k.s              JOIN pg_attribute ta ON ta.attrelid = tc.oid AND ta.attnum = k.t              WHERE con.contype = 'f' AND sn.nspname = {s} AND sc.relname = {t} ORDER BY 3, k.ord"
        ),
        DbDriver::Mysql => format!(
            "SELECT table_schema, table_name, constraint_name, column_name,              referenced_table_schema, referenced_table_name, referenced_column_name              FROM information_schema.key_column_usage WHERE referenced_table_name IS NOT NULL              AND table_schema = {s} AND table_name = {t} ORDER BY constraint_name, ordinal_position"
        ),
        DbDriver::SqlServer => format!(
            "SELECT table_schema, table_name, constraint_name, column_name,              referenced_table_schema, referenced_table_name, referenced_column_name              FROM information_schema.key_column_usage WHERE referenced_table_name IS NOT NULL              AND table_schema = {s} AND table_name = {t} ORDER BY constraint_name, ordinal_position"
        ),
        DbDriver::Oracle => format!(
            "SELECT con.owner, con.table_name, con.constraint_name, col.column_name,              rcon.owner, rcon.table_name, rcol.column_name              FROM all_constraints con              JOIN all_cons_columns col ON col.owner = con.owner AND col.table_name = con.table_name              AND col.constraint_name = con.constraint_name              JOIN all_constraints rcon ON rcon.owner = con.r_owner AND rcon.constraint_name = con.r_constraint_name              JOIN all_cons_columns rcol ON rcol.owner = rcon.owner AND rcol.table_name = rcon.table_name              AND rcol.constraint_name = rcon.constraint_name              WHERE con.constraint_type = 'R' AND con.owner = {s} AND con.table_name = {t}              ORDER BY con.constraint_name, col.position"
        ),
    }
}

/// The schema unqualified names resolve to (`None`: always `main`).
pub fn current_schema(driver: DbDriver) -> Option<&'static str> {
    match driver {
        DbDriver::Clickhouse => Some("SELECT currentDatabase()"),
        DbDriver::Sqlite => None,
        DbDriver::Postgres => Some("SELECT current_schema()"),
        DbDriver::Mysql => Some("SELECT DATABASE()"),
        DbDriver::SqlServer => Some("SELECT DB_NAME()"),
        DbDriver::Oracle => Some("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL"),
    }
}

/// The statement that makes unqualified names resolve in `schema` on the
/// connection that runs it (a query console's active schema; `None`: the driver
/// has no schema to switch — SQLite's `main`, ClickHouse's `USE` differs).
pub fn use_schema(driver: DbDriver, schema: &str) -> Option<String> {
    match driver {
        DbDriver::Sqlite | DbDriver::Clickhouse => None,
        DbDriver::Postgres => Some(format!("SET search_path TO {}", quote_ident(driver, schema))),
        DbDriver::Mysql | DbDriver::SqlServer => Some(format!("USE {}", quote_ident(driver, schema))),
        DbDriver::Oracle => Some(format!("ALTER SESSION SET CURRENT_SCHEMA = {}", quote_ident(driver, schema))),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbSortKey")]
pub struct SortKey {
    pub column: String,
    pub descending: bool,
}

/// One page of a table: `limit + 1` rows so the caller knows whether more exist.
pub fn table_page(
    driver: DbDriver,
    schema: &str,
    table: &str,
    filter: Option<&str>,
    sort: &[SortKey],
    offset: u64,
    limit: u64,
) -> String {
    let mut sql = format!("SELECT * FROM {}", qualified(driver, schema, table));
    if let Some(f) = filter.map(str::trim).filter(|f| !f.is_empty()) {
        let mut f = f.strip_prefix("WHERE ").or_else(|| f.strip_prefix("where ")).unwrap_or(f);
        if let Some(i) = f.find(';') {
            f = &f[..i];
        }
        f = f.trim();
        if !f.is_empty() {
            sql.push_str(&format!(" WHERE {f}"));
        }
    }
    if !sort.is_empty() {
        let keys: Vec<String> = sort
            .iter()
            .map(|k| format!("{}{}", quote_ident(driver, &k.column), if k.descending { " DESC" } else { "" }))
            .collect();
        sql.push_str(&format!(" ORDER BY {}", keys.join(", ")));
    }
    if driver == DbDriver::SqlServer {
        if sort.is_empty() {
            sql.push_str(" ORDER BY (SELECT 1)");
        }
        sql.push_str(&format!(" OFFSET {offset} ROWS FETCH NEXT {} ROWS ONLY", limit + 1));
    } else if driver == DbDriver::Oracle {
        sql.push_str(&format!(" OFFSET {offset} ROWS FETCH FIRST {} ROWS ONLY", limit + 1));
    } else {
        sql.push_str(&format!(" LIMIT {} OFFSET {offset}", limit + 1));
    }
    sql
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbCellValue")]
pub struct CellValue {
    pub column: String,
    /// `None` is SQL NULL.
    pub value: Option<String>,
}

/// A pending change of the table editor. `key` identifies the row: its primary
/// key columns with their original values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DbRowEdit {
    Update { key: Vec<CellValue>, values: Vec<CellValue> },
    Insert { values: Vec<CellValue> },
    Delete { key: Vec<CellValue> },
}

fn where_key(driver: DbDriver, key: &[CellValue]) -> String {
    key.iter()
        .map(|c| match &c.value {
            Some(v) => format!("{} = {}", quote_ident(driver, &c.column), quote_literal(driver, v)),
            None => format!("{} IS NULL", quote_ident(driver, &c.column)),
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// The DML statement for `edit`. Values are written as quoted literals, which
/// every supported database coerces to the column type.
pub fn edit_statement(driver: DbDriver, schema: &str, table: &str, edit: &DbRowEdit) -> Result<String, String> {
    if driver == DbDriver::Clickhouse {
        return Err("ClickHouse table editing is unsupported: primary keys do not uniquely identify rows and edits require transactions".into());
    }
    let target = qualified(driver, schema, table);
    match edit {
        DbRowEdit::Update { key, values } => {
            if key.is_empty() {
                return Err("rows can only be updated in tables with a primary key".into());
            }
            if values.is_empty() {
                return Err("nothing to update".into());
            }
            let set: Vec<String> = values
                .iter()
                .map(|c| {
                    format!("{} = {}", quote_ident(driver, &c.column), literal_or_null(driver, c.value.as_deref()))
                })
                .collect();
            Ok(format!("UPDATE {target} SET {} WHERE {}", set.join(", "), where_key(driver, key)))
        }
        DbRowEdit::Insert { values } => {
            if values.is_empty() {
                return Ok(match driver {
                    DbDriver::Mysql => format!("INSERT INTO {target} () VALUES ()"),
                    // Oracle has no DEFAULT VALUES; without columns there is nothing to insert.
                    DbDriver::Oracle => return Err("Oracle needs at least one column value to insert".into()),
                    _ => format!("INSERT INTO {target} DEFAULT VALUES"),
                });
            }
            let cols: Vec<String> = values.iter().map(|c| quote_ident(driver, &c.column)).collect();
            let vals: Vec<String> = values.iter().map(|c| literal_or_null(driver, c.value.as_deref())).collect();
            Ok(format!("INSERT INTO {target} ({}) VALUES ({})", cols.join(", "), vals.join(", ")))
        }
        DbRowEdit::Delete { key } => {
            if key.is_empty() {
                return Err("rows can only be deleted in tables with a primary key".into());
            }
            Ok(format!("DELETE FROM {target} WHERE {}", where_key(driver, key)))
        }
    }
}

/// Rows: `sql` — the statements that created a SQLite table or view, then its indexes and triggers.
pub fn sqlite_ddl(schema: &str, name: &str) -> String {
    format!(
        "SELECT sql FROM {}.sqlite_master WHERE tbl_name = {} AND sql IS NOT NULL \
         ORDER BY CASE type WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 0 END, name",
        quote_ident(DbDriver::Sqlite, schema),
        quote_literal(DbDriver::Sqlite, name)
    )
}

/// Rows: `oid, relkind` of a PostgreSQL relation.
pub fn postgres_relation(schema: &str, name: &str) -> String {
    format!(
        "SELECT c.oid::text, c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = {} AND c.relname = {}",
        quote_literal(DbDriver::Postgres, schema),
        quote_literal(DbDriver::Postgres, name)
    )
}

/// Rows: `name, type, not null (0/1), default` of relation `oid`.
pub fn postgres_ddl_columns(oid: u32) -> String {
    format!(
        "SELECT a.attname, format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN 1 ELSE 0 END, \
         pg_get_expr(d.adbin, d.adrelid) FROM pg_attribute a \
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
         WHERE a.attrelid = {oid} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"
    )
}

/// Rows: `name, definition` of the constraints of relation `oid` (primary key first).
pub fn postgres_ddl_constraints(oid: u32) -> String {
    format!(
        "SELECT conname, pg_get_constraintdef(oid, true) FROM pg_constraint WHERE conrelid = {oid} \
         ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'f' THEN 3 ELSE 4 END, conname"
    )
}

/// Rows: `CREATE INDEX …` of relation `oid`, except the indexes behind constraints.
pub fn postgres_ddl_indexes(oid: u32) -> String {
    format!(
        "SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indrelid = {oid} \
         AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid AND c.conrelid = i.indrelid) \
         ORDER BY 1"
    )
}

/// Rows: `name, timing, events` of the triggers of a table (SQLite: `name, sql`).
pub fn triggers(driver: DbDriver, schema: &str, table: &str) -> String {
    let (s, t) = (quote_literal(driver, schema), quote_literal(driver, table));
    match driver {
        DbDriver::Clickhouse => "SELECT '', '', '' WHERE 0".to_owned(),
        DbDriver::Sqlite => format!(
            "SELECT name, sql FROM {}.sqlite_master WHERE type = 'trigger' AND tbl_name = {t} ORDER BY name",
            quote_ident(driver, schema)
        ),
        DbDriver::Postgres => format!(
            "SELECT t.tgname, CASE WHEN t.tgtype & 2 <> 0 THEN 'before' WHEN t.tgtype & 64 <> 0 THEN 'instead of' \
             ELSE 'after' END, concat_ws(' or ', CASE WHEN t.tgtype & 4 <> 0 THEN 'insert' END, \
             CASE WHEN t.tgtype & 16 <> 0 THEN 'update' END, CASE WHEN t.tgtype & 8 <> 0 THEN 'delete' END, \
             CASE WHEN t.tgtype & 32 <> 0 THEN 'truncate' END) \
             FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE NOT t.tgisinternal AND n.nspname = {s} AND c.relname = {t} ORDER BY 1"
        ),
        DbDriver::Mysql => format!(
            "SELECT trigger_name, lower(action_timing), lower(event_manipulation) FROM information_schema.triggers \
             WHERE event_object_schema = {s} AND event_object_table = {t} ORDER BY 1"
        ),
        DbDriver::SqlServer => format!(
            "SELECT t.name, lower(te.type_desc), '' FROM sys.triggers t \
             WHERE OBJECT_SCHEMA_NAME(t.parent_id) = {s} AND OBJECT_NAME(t.parent_id) = {t} ORDER BY 1"
        ),
        DbDriver::Oracle => format!(
            "SELECT trigger_name, CASE WHEN trigger_type LIKE 'BEFORE%' THEN 'before' \
             WHEN trigger_type LIKE 'INSTEAD%' THEN 'instead of' ELSE 'after' END, \
             lower(replace(triggering_event, ' OR ', ',')) \
             FROM all_triggers WHERE owner = {s} AND table_name = {t} ORDER BY 1"
        ),
    }
}

/// `before`, `insert` of SQLite's `CREATE TRIGGER name BEFORE INSERT ON …` (its catalog keeps only the text).
pub fn sqlite_trigger_event(sql: &str) -> (String, String) {
    let upper = sql.to_ascii_uppercase();
    let words: Vec<&str> = upper.split_whitespace().collect();
    let timing = if words.contains(&"BEFORE") {
        "before"
    } else if words.windows(2).any(|w| w == ["INSTEAD", "OF"]) {
        "instead of"
    } else {
        "after"
    };
    let event = ["INSERT", "UPDATE", "DELETE"].into_iter().find(|e| words.contains(e)).unwrap_or_default();
    (timing.to_owned(), event.to_ascii_lowercase())
}

/// Rows: `name, kind (function/procedure), arguments, result` of a schema's routines (none in SQLite).
pub fn routines(driver: DbDriver, schema: &str) -> Option<String> {
    let s = quote_literal(driver, schema);
    match driver {
        DbDriver::Sqlite | DbDriver::Clickhouse => None,
        // Functions of extensions are left out, as in IDEA.
        DbDriver::Postgres => Some(format!(
            "SELECT p.proname, CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END, \
             pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid) \
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = {s} AND p.prokind IN ('f', 'p') \
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ORDER BY 1, 3"
        )),
        DbDriver::Mysql => Some(format!(
            "SELECT r.routine_name, lower(r.routine_type), \
             (SELECT GROUP_CONCAT(CONCAT(p.parameter_name, ' ', p.dtd_identifier) ORDER BY p.ordinal_position \
              SEPARATOR ', ') FROM information_schema.parameters p WHERE p.specific_schema = r.routine_schema \
              AND p.specific_name = r.specific_name AND p.ordinal_position > 0), r.dtd_identifier \
             FROM information_schema.routines r WHERE r.routine_schema = {s} ORDER BY 1"
        )),
        DbDriver::SqlServer => Some(format!(
            "SELECT r.routine_name, lower(r.routine_type), '', r.data_type \
             FROM information_schema.routines r WHERE r.routine_schema = {s} ORDER BY 1"
        )),
        DbDriver::Oracle => Some(format!(
            "SELECT object_name, CASE object_type WHEN 'PROCEDURE' THEN 'procedure' ELSE 'function' END, '', NULL \
             FROM all_objects WHERE owner = {s} AND object_type IN ('PROCEDURE', 'FUNCTION') \
             AND object_name NOT LIKE 'BIN$%' ORDER BY 1"
        )),
    }
}

/// Rows: `name` of a schema's packages (Oracle only; their procedures and functions are not
/// listed separately, as in IDEA).
pub fn packages(driver: DbDriver, schema: &str) -> Option<String> {
    match driver {
        DbDriver::Oracle => Some(format!(
            "SELECT object_name FROM all_objects WHERE owner = {} AND object_type = 'PACKAGE' \
             AND object_name NOT LIKE 'BIN$%' ORDER BY 1",
            quote_literal(driver, schema)
        )),
        _ => None,
    }
}

/// The statement reading a package's specification (`body` false) or body as DDL.
pub fn package_ddl(driver: DbDriver, schema: &str, name: &str, body: bool) -> Option<String> {
    match driver {
        DbDriver::Oracle => Some(format!(
            "SELECT DBMS_METADATA.GET_DDL('{}', {}, {}) FROM DUAL",
            if body { "PACKAGE_BODY" } else { "PACKAGE" },
            quote_literal(driver, name),
            quote_literal(driver, schema)
        )),
        _ => None,
    }
}

/// Rows: `name, data type` of a schema's sequences (PostgreSQL, Oracle).
pub fn sequences(driver: DbDriver, schema: &str) -> Option<String> {
    match driver {
        DbDriver::Postgres => Some(format!(
            "SELECT sequence_name, data_type FROM information_schema.sequences WHERE sequence_schema = {} ORDER BY 1",
            quote_literal(driver, schema)
        )),
        // Every sequence is numeric; ALL_SEQUENCES has no data_type column before 18c.
        DbDriver::Oracle => Some(format!(
            "SELECT sequence_name, 'NUMBER' FROM all_sequences WHERE sequence_owner = {} ORDER BY 1",
            quote_literal(driver, schema)
        )),
        _ => None,
    }
}

/// The statement reading the definition of a routine (a row per overload), trigger
/// or sequence, and the column that holds it.
pub fn object_ddl(driver: DbDriver, schema: &str, kind: crate::DbObjectKind, name: &str) -> Option<(String, usize)> {
    use crate::DbObjectKind as K;
    let (s, n) = (quote_literal(driver, schema), quote_literal(driver, name));
    let target = qualified(driver, schema, name);
    Some(match (driver, kind) {
        (DbDriver::Sqlite, K::Trigger) => (
            format!(
                "SELECT sql FROM {}.sqlite_master WHERE type = 'trigger' AND name = {n}",
                quote_ident(driver, schema)
            ),
            0,
        ),
        (DbDriver::Postgres, K::Function | K::Procedure) => (
            format!(
                "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = {s} AND p.proname = {n} ORDER BY pg_get_function_identity_arguments(p.oid)"
            ),
            0,
        ),
        (DbDriver::Postgres, K::Trigger) => (
            format!(
                "SELECT pg_get_triggerdef(t.oid, true) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE NOT t.tgisinternal AND n.nspname = {s} AND t.tgname = {n}"
            ),
            0,
        ),
        (DbDriver::Postgres, K::Sequence) => (
            format!(
                "SELECT format(E'create sequence %s\\n    as %s\\n    increment by %s\\n    minvalue %s\\n    \
                 maxvalue %s\\n    start with %s%s', {}, data_type, increment_by, min_value, max_value, start_value, \
                 CASE WHEN cycle THEN E'\\n    cycle' ELSE '' END) \
                 FROM pg_sequences WHERE schemaname = {s} AND sequencename = {n}",
                quote_literal(driver, &target)
            ),
            0,
        ),
        (DbDriver::Mysql, K::Function) => (format!("SHOW CREATE FUNCTION {target}"), 2),
        (DbDriver::Mysql, K::Procedure) => (format!("SHOW CREATE PROCEDURE {target}"), 2),
        (DbDriver::Mysql, K::Trigger) => (format!("SHOW CREATE TRIGGER {target}"), 2),
        (DbDriver::Oracle, K::Function | K::Procedure | K::Trigger) => (
            format!(
                "SELECT DBMS_METADATA.GET_DDL('{}', {n}, {s}) FROM DUAL",
                match kind {
                    K::Function => "FUNCTION",
                    K::Procedure => "PROCEDURE",
                    _ => "TRIGGER",
                }
            ),
            0,
        ),
        (DbDriver::Oracle, K::Sequence) => (
            format!(
                "SELECT 'create sequence ' || {n} || E'\\n    increment by ' || increment_by || \
                 E'\\n    minvalue ' || min_value || E'\\n    maxvalue ' || max_value || \
                 E'\\n    start with ' || last_number || CASE WHEN cycle_flag = 'Y' THEN E'\\n    cycle' ELSE '' END \
                 FROM all_sequences WHERE sequence_owner = {s} AND sequence_name = {n}"
            ),
            0,
        ),
        _ => return None,
    })
}

/// A column of [`postgres_table_ddl`].
pub struct DdlColumn {
    pub name: String,
    pub data_type: String,
    pub not_null: bool,
    pub default: Option<String>,
}

/// `create table` of a PostgreSQL table from its catalog (the server has no `SHOW CREATE`).
pub fn postgres_table_ddl(
    schema: &str,
    table: &str,
    columns: &[DdlColumn],
    constraints: &[(String, String)],
    indexes: &[String],
) -> String {
    let d = DbDriver::Postgres;
    let mut items: Vec<String> = columns
        .iter()
        .map(|c| {
            let mut s = format!("    {} {}", quote_ident(d, &c.name), c.data_type);
            if let Some(v) = &c.default {
                s.push_str(&format!(" default {v}"));
            }
            if c.not_null {
                s.push_str(" not null");
            }
            s
        })
        .collect();
    items.extend(constraints.iter().map(|(name, def)| format!("    constraint {} {def}", quote_ident(d, name))));
    let mut out = format!("create table {}\n(\n{}\n);\n", qualified(d, schema, table), items.join(",\n"));
    for i in indexes {
        out.push_str(&format!("\n{i};\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cv(c: &str, v: Option<&str>) -> CellValue {
        CellValue { column: c.into(), value: v.map(Into::into) }
    }

    #[test]
    fn quoting() {
        assert_eq!(quote_ident(DbDriver::Postgres, "a\"b"), "\"a\"\"b\"");
        assert_eq!(quote_ident(DbDriver::Mysql, "a`b"), "`a``b`");
        assert_eq!(quote_literal(DbDriver::Sqlite, "it's \\"), "'it''s \\'");
        assert_eq!(quote_literal(DbDriver::Mysql, "it's \\"), "'it''s \\\\'");
    }

    #[test]
    fn clickhouse_escapes_backslashes_and_delimiters() {
        let driver = DbDriver::Clickhouse;
        assert_eq!(quote_literal(driver, r"path\O'Brien"), r"'path\\O''Brien'");
        assert_eq!(quote_literal(driver, r"\' OR 1 = 1 --"), r"'\\'' OR 1 = 1 --'");
        assert_eq!(quote_ident(driver, r"a\`b"), r"`a\\\`b`");
        assert_eq!(qualified(driver, "data base", "event`log"), r"`data base`.`event\`log`");
    }

    #[test]
    fn clickhouse_metadata_preserves_types_defaults_and_nonunique_keys() {
        let driver = DbDriver::Clickhouse;
        assert_eq!(schemas(driver, true), "SELECT name FROM system.databases ORDER BY name");
        assert!(schemas(driver, false).contains("lower(name) NOT IN ('system', 'information_schema')"));
        assert_eq!(current_schema(driver), Some("SELECT currentDatabase()"));
        let relations = tables(driver, "event's\\db");
        assert!(relations.contains("WHEN 'MaterializedView' THEN 'materialized view'"));
        assert!(relations.contains(r"WHERE database = 'event''s\\db' AND is_temporary = 0"));
        let fields = columns(driver, "default", "events");
        assert!(fields.starts_with("SELECT name, type, CASE WHEN startsWith(type, 'Nullable(')"));
        assert!(fields.contains("startsWith(type, 'LowCardinality(Nullable(')"));
        assert!(fields.contains("if(default_kind = '', NULL, default_expression), is_in_primary_key"));
        assert!(fields.ends_with("WHERE database = 'default' AND table = 'events' ORDER BY position"));
        let keys = indexes(driver, "default", "events");
        assert!(keys.contains("'PRIMARY KEY' AS index_name, 0 AS is_unique, primary_key AS expression"));
        assert!(keys.contains("SELECT name, 0, expr FROM system.data_skipping_indices"));
        let completion = completion_columns(driver);
        assert!(completion.contains("c.is_in_primary_key, 1"));
        assert!(completion.contains("ORDER BY c.database, c.table, c.position LIMIT 50000"));
    }

    #[test]
    fn clickhouse_has_no_foreign_key_trigger_or_schema_routine_catalogs() {
        let driver = DbDriver::Clickhouse;
        assert_eq!(foreign_keys(driver), "SELECT '', '', '', '', '', '', '' WHERE 0");
        assert_eq!(table_foreign_keys(driver, "default", "events"), foreign_keys(driver));
        assert_eq!(triggers(driver, "default", "events"), "SELECT '', '', '' WHERE 0");
        assert!(routines(driver, "default").is_none());
        assert!(sequences(driver, "default").is_none());
        assert!(object_ddl(driver, "default", crate::DbObjectKind::Trigger, "t").is_none());
    }

    #[test]
    fn clickhouse_pages_quote_keys_and_fetch_one_extra_row() {
        let sort = [SortKey { column: "event`id".into(), descending: true }];
        assert_eq!(
            table_page(DbDriver::Clickhouse, "default", "events", Some("WHERE id > 3"), &sort, 50, 25),
            r"SELECT * FROM `default`.`events` WHERE id > 3 ORDER BY `event\`id` DESC LIMIT 26 OFFSET 50"
        );
    }

    #[test]
    fn clickhouse_keys_never_enable_transactional_table_edits() {
        let key = vec![cv("id", Some("1"))];
        for edit in [
            DbRowEdit::Update { key: key.clone(), values: vec![cv("name", Some("new"))] },
            DbRowEdit::Delete { key },
            DbRowEdit::Insert { values: vec![cv("name", Some("new"))] },
            DbRowEdit::Insert { values: vec![] },
        ] {
            let error = edit_statement(DbDriver::Clickhouse, "default", "events", &edit).unwrap_err();
            assert!(error.contains("primary keys do not uniquely identify rows"));
        }
    }

    #[test]
    fn pages() {
        let sort = [SortKey { column: "id".into(), descending: true }];
        assert_eq!(
            table_page(DbDriver::Postgres, "public", "users", Some("WHERE age > 3"), &sort, 100, 50),
            "SELECT * FROM \"public\".\"users\" WHERE age > 3 ORDER BY \"id\" DESC LIMIT 51 OFFSET 100"
        );
        assert_eq!(table_page(DbDriver::Mysql, "", "t", Some("  "), &[], 0, 10), "SELECT * FROM `t` LIMIT 11 OFFSET 0");
        assert_eq!(
            table_page(DbDriver::SqlServer, "dbo", "users", Some("id = 1;"), &[], 0, 500),
            "SELECT * FROM [dbo].[users] WHERE id = 1 ORDER BY (SELECT 1) OFFSET 0 ROWS FETCH NEXT 501 ROWS ONLY"
        );
    }

    #[test]
    fn edits() {
        let key = vec![cv("id", Some("1"))];
        assert_eq!(
            edit_statement(
                DbDriver::Sqlite,
                "main",
                "t",
                &DbRowEdit::Update { key: key.clone(), values: vec![cv("name", Some("O'Brien")), cv("note", None)] }
            )
            .unwrap(),
            "UPDATE \"main\".\"t\" SET \"name\" = 'O''Brien', \"note\" = NULL WHERE \"id\" = '1'"
        );
        assert_eq!(
            edit_statement(DbDriver::Mysql, "db", "t", &DbRowEdit::Insert { values: vec![cv("a", Some("x"))] })
                .unwrap(),
            "INSERT INTO `db`.`t` (`a`) VALUES ('x')"
        );
        assert_eq!(
            edit_statement(DbDriver::Postgres, "s", "t", &DbRowEdit::Delete { key: vec![cv("k", None)] }).unwrap(),
            "DELETE FROM \"s\".\"t\" WHERE \"k\" IS NULL"
        );
        assert!(edit_statement(DbDriver::Postgres, "s", "t", &DbRowEdit::Delete { key: vec![] }).is_err());
    }

    #[test]
    fn sqlserver_quoting_and_schema() {
        assert_eq!(quote_ident(DbDriver::SqlServer, "a]b"), "[a]]b]");
        assert_eq!(qualified(DbDriver::SqlServer, "dbo", "t"), "[dbo].[t]");
        assert_eq!(qualified(DbDriver::SqlServer, "", "t"), "[t]");
        assert_eq!(current_schema(DbDriver::SqlServer), Some("SELECT DB_NAME()"));
        assert_eq!(crate::conn::begin_statement(DbDriver::SqlServer), "BEGIN TRAN");
        assert_eq!(
            schemas(DbDriver::SqlServer, true),
            "SELECT schema_name FROM information_schema.schemata ORDER BY 1"
        );
        assert!(schemas(DbDriver::SqlServer, false).contains("NOT IN ('sys', 'information_schema', 'guest')"));
    }

    #[test]
    fn sqlserver_introspection_queries() {
        assert!(tables(DbDriver::SqlServer, "dbo").contains("information_schema.tables"));
        assert!(columns(DbDriver::SqlServer, "dbo", "t").contains("information_schema.columns"));
        assert!(indexes(DbDriver::SqlServer, "dbo", "t").contains("sys.indexes"));
        assert!(foreign_keys(DbDriver::SqlServer).contains("referenced_table_name IS NOT NULL"));
        assert!(table_foreign_keys(DbDriver::SqlServer, "dbo", "t").contains("table_schema = 'dbo'"));
        assert!(completion_columns(DbDriver::SqlServer).contains("information_schema.columns"));
    }

    #[test]
    fn oracle_quoting_pages_and_current_schema() {
        assert_eq!(quote_ident(DbDriver::Oracle, "a\"b"), "\"a\"\"b\"");
        assert_eq!(quote_literal(DbDriver::Oracle, "it's"), "'it''s'");
        assert_eq!(qualified(DbDriver::Oracle, "hr", "employees"), "\"hr\".\"employees\"");
        assert_eq!(current_schema(DbDriver::Oracle), Some("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL"));
        assert_eq!(crate::conn::begin_statement(DbDriver::Oracle), "");
        let sort = [SortKey { column: "id".into(), descending: true }];
        assert_eq!(
            table_page(DbDriver::Oracle, "hr", "employees", Some("WHERE id > 3"), &sort, 50, 25),
            "SELECT * FROM \"hr\".\"employees\" WHERE id > 3 ORDER BY \"id\" DESC OFFSET 50 ROWS FETCH FIRST 26 ROWS ONLY"
        );
        assert_eq!(
            table_page(DbDriver::Oracle, "", "t", None, &[], 0, 10),
            "SELECT * FROM \"t\" OFFSET 0 ROWS FETCH FIRST 11 ROWS ONLY"
        );
    }

    #[test]
    fn oracle_introspection_queries() {
        assert_eq!(DbDriver::Oracle.default_port(), Some(1521));
        assert!(schemas(DbDriver::Oracle, true).contains("all_users"));
        assert!(schemas(DbDriver::Oracle, false).contains("'MDSYS'"));
        assert!(tables(DbDriver::Oracle, "hr").contains("all_tables"));
        assert!(tables(DbDriver::Oracle, "hr").contains("all_views"));
        let cols = columns(DbDriver::Oracle, "hr", "employees");
        assert!(cols.contains("all_tab_columns"));
        assert!(cols.contains("DECODE(c.nullable, 'Y', 'YES', 'NO')"));
        assert!(cols.contains("constraint_type = 'P'"));
        assert!(indexes(DbDriver::Oracle, "hr", "t").contains("all_indexes"));
        assert!(foreign_keys(DbDriver::Oracle).contains("constraint_type = 'R'"));
        assert!(table_foreign_keys(DbDriver::Oracle, "hr", "t").contains("all_cons_columns"));
        assert!(completion_columns(DbDriver::Oracle).contains("all_tab_columns"));
        assert!(triggers(DbDriver::Oracle, "hr", "t").contains("all_triggers"));
        assert!(routines(DbDriver::Oracle, "hr").unwrap().contains("all_objects"));
        assert!(packages(DbDriver::Oracle, "hr").unwrap().contains("object_type = 'PACKAGE'"));
        assert!(sequences(DbDriver::Oracle, "hr").unwrap().contains("all_sequences"));
    }

    #[test]
    fn oracle_edits_and_object_ddl() {
        let key = vec![cv("id", Some("1"))];
        assert_eq!(
            edit_statement(
                DbDriver::Oracle,
                "hr",
                "t",
                &DbRowEdit::Update { key: key.clone(), values: vec![cv("n", Some("x"))] }
            )
            .unwrap(),
            "UPDATE \"hr\".\"t\" SET \"n\" = 'x' WHERE \"id\" = '1'"
        );
        assert!(edit_statement(DbDriver::Oracle, "hr", "t", &DbRowEdit::Insert { values: vec![] }).is_err());
        use crate::DbObjectKind as K;
        let (q, col) = object_ddl(DbDriver::Oracle, "hr", K::Procedure, "p").unwrap();
        assert!(q.contains("DBMS_METADATA.GET_DDL('PROCEDURE'") && col == 0);
        assert!(object_ddl(DbDriver::Oracle, "hr", K::Sequence, "q").unwrap().0.contains("all_sequences"));
        assert!(
            package_ddl(DbDriver::Oracle, "hr", "pkg", false)
                .unwrap()
                .contains("DBMS_METADATA.GET_DDL('PACKAGE', 'pkg', 'hr')")
        );
        assert!(
            package_ddl(DbDriver::Oracle, "hr", "pkg", true)
                .unwrap()
                .contains("DBMS_METADATA.GET_DDL('PACKAGE_BODY', 'pkg', 'hr')")
        );
        assert!(package_ddl(DbDriver::Postgres, "public", "pkg", false).is_none());
    }

    #[test]
    fn sqlite_trigger_events() {
        let ev = sqlite_trigger_event;
        assert_eq!(
            ev("CREATE TRIGGER t BEFORE UPDATE OF a ON x BEGIN SELECT 1; END"),
            ("before".into(), "update".into())
        );
        assert_eq!(ev("create trigger t instead of insert on v begin end"), ("instead of".into(), "insert".into()));
        assert_eq!(ev("CREATE TRIGGER t DELETE ON x BEGIN END"), ("after".into(), "delete".into()));
    }

    #[test]
    fn schema_objects_per_dialect() {
        use crate::DbObjectKind as K;
        assert!(routines(DbDriver::Sqlite, "main").is_none());
        assert!(packages(DbDriver::Sqlite, "main").is_none());
        assert!(sequences(DbDriver::Mysql, "db").is_none());
        assert!(routines(DbDriver::Postgres, "public").unwrap().contains("n.nspname = 'public'"));
        assert_eq!(
            object_ddl(DbDriver::Mysql, "db", K::Procedure, "p"),
            Some(("SHOW CREATE PROCEDURE `db`.`p`".into(), 2))
        );
        assert!(object_ddl(DbDriver::Sqlite, "main", K::Function, "f").is_none());
        assert!(object_ddl(DbDriver::Postgres, "s", K::Sequence, "q").unwrap().0.contains("sequencename = 'q'"));
    }

    #[test]
    fn schema_switch_statement_per_dialect() {
        assert_eq!(use_schema(DbDriver::Postgres, "app data"), Some("SET search_path TO \"app data\"".into()));
        assert_eq!(use_schema(DbDriver::Mysql, "a`b"), Some("USE `a``b`".into()));
        assert_eq!(use_schema(DbDriver::SqlServer, "app] data"), Some("USE [app]] data]".into()));
        assert_eq!(use_schema(DbDriver::Postgres, "a\"b"), Some("SET search_path TO \"a\"\"b\"".into()));
        assert_eq!(use_schema(DbDriver::Oracle, "a\"b"), Some("ALTER SESSION SET CURRENT_SCHEMA = \"a\"\"b\"".into()));
        assert!(sqlserver_databases().contains("state = 0 AND HAS_DBACCESS(name) = 1"));
        assert_eq!(use_schema(DbDriver::Oracle, "hr"), Some("ALTER SESSION SET CURRENT_SCHEMA = \"hr\"".into()));
        // Single-schema (SQLite) and not-yet-supported drivers: no dropdown, no switch.
        assert_eq!(use_schema(DbDriver::Sqlite, "main"), None);
        assert_eq!(use_schema(DbDriver::Clickhouse, "default"), None);
    }

    #[test]
    fn postgres_ddl() {
        let cols = [
            DdlColumn { name: "id".into(), data_type: "integer".into(), not_null: true, default: None },
            DdlColumn {
                name: "name".into(),
                data_type: "character varying(40)".into(),
                not_null: false,
                default: Some("'x'::character varying".into()),
            },
        ];
        assert_eq!(
            postgres_table_ddl(
                "public",
                "t",
                &cols,
                &[("t_pkey".into(), "PRIMARY KEY (id)".into())],
                &["CREATE INDEX t_name ON public.t USING btree (name)".into()]
            ),
            "create table \"public\".\"t\"\n(\n    \"id\" integer not null,\n    \"name\" character varying(40) default 'x'::character varying,\n    constraint \"t_pkey\" PRIMARY KEY (id)\n);\n\nCREATE INDEX t_name ON public.t USING btree (name);\n"
        );
    }
}
