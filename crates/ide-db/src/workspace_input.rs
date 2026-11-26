//! Bounded, typed reads for staging explicitly selected database tables.
use crate::{DbDriver, DbManager, Pool, conn::db_err, route::RouteUse, sql};
use futures::TryStreamExt;
use ide_core::{CancellationToken, IdeError, IdeResult};
use sqlx::{Row, postgres::PgConnection};
use std::{borrow::Cow, fmt::Write};

const MAX_COLUMNS: usize = 128;

#[derive(Debug, Clone)]
pub struct WorkspaceInputRequest {
    pub source_id: String,
    pub database: String,
    pub schema: String,
    pub table: String,
    pub limits: WorkspaceInputLimits,
}

#[derive(Debug, Clone, Copy)]
pub struct WorkspaceInputLimits {
    pub max_rows: usize,
    pub max_cell_bytes: usize,
    pub max_bytes: usize,
}

#[derive(Debug)]
pub struct WorkspaceInput {
    pub columns: Vec<WorkspaceInputColumn>,
    /// Exact text accepted by the workspace engine, with SQL NULL represented separately.
    pub rows: Vec<Vec<Option<String>>>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct WorkspaceInputColumn {
    pub name: String,
    pub data_type: WorkspaceInputType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceInputType {
    Boolean,
    Int8,
    Int16,
    Int32,
    Int64,
    UInt8,
    UInt16,
    UInt32,
    UInt64,
    Float32,
    Float64,
    Decimal { precision: u8, scale: u8 },
    Text,
    Date,
    Time,
    Timestamp,
    TimestampTz,
    Uuid,
}

/// Opens an independent read-only connection through the saved source's approved route.
pub async fn read_table(
    db: &DbManager,
    request: &WorkspaceInputRequest,
    cancel: &CancellationToken,
) -> IdeResult<WorkspaceInput> {
    let limits = request.limits;
    if !(1..=100_000).contains(&limits.max_rows)
        || !(1..=1_048_576).contains(&limits.max_cell_bytes)
        || !(1..=16_777_216).contains(&limits.max_bytes)
    {
        return Err(IdeError::invalid("Workspace source limits are out of range"));
    }
    if request.source_id.is_empty() || request.source_id.contains(':') {
        return Err(IdeError::invalid("Select a saved data source for the workspace"));
    }
    let source = db.source(&request.source_id)?;
    let driver = source.driver;
    if !source.options.startup_script.trim().is_empty() {
        return Err(IdeError::invalid("Workspace inputs do not run saved source startup scripts"));
    }
    if !matches!(driver, DbDriver::Postgres | DbDriver::Clickhouse) {
        return Err(IdeError::invalid("Workspace inputs require a native PostgreSQL or ClickHouse data source"));
    }
    for name in [&request.database, &request.schema, &request.table] {
        if name.contains('\0') || name.len() > 255 || (driver == DbDriver::Postgres && name.len() > 63) {
            return Err(IdeError::invalid("Workspace input name is invalid"));
        }
    }
    if request.table.is_empty()
        || (driver == DbDriver::Postgres && request.schema.is_empty())
        || (driver == DbDriver::Clickhouse && request.database.is_empty())
    {
        return Err(IdeError::invalid("Select a qualified table for the workspace"));
    }
    if driver == DbDriver::Clickhouse && !request.schema.is_empty() && request.schema != request.database {
        return Err(IdeError::invalid("ClickHouse input schema must match its database"));
    }
    let open = async {
        let password = db.password(&source).await;
        let (mut target, route) = db.endpoint(&source, None, RouteUse::Connect).await?;
        if !request.database.is_empty() {
            target.select_database(Some(&request.database));
        }
        target.read_only = true;
        if driver == DbDriver::Clickhouse {
            target.options.default_schema.clear();
            target.properties.retain(|p| !p.name.trim().replace('-', "_").eq_ignore_ascii_case("use_http_session"));
            // Do not retain a server session for a workspace that only issues qualified SELECTs.
            target.properties.push(crate::DbProperty { name: "use_http_session".into(), value: "false".into() });
        }
        let pool =
            db.open_pool(&target, password.as_deref(), false).await.map_err(|e| db.connection_error(e, &source))?;
        Ok::<_, IdeError>((pool, route))
    };
    let (pool, _route) = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(IdeError::cancelled()),
        () = tokio::time::sleep(std::time::Duration::from_secs(30)) =>
            return Err(IdeError::new(ide_core::error::ErrorKind::TimedOut, "Workspace source connection timed out")),
        result = open => result?,
    };
    match &pool {
        Pool::Postgres(_) => pool.read_workspace_postgres(request, cancel).await,
        Pool::Clickhouse(pool) => read_clickhouse(pool, request, cancel).await,
        _ => unreachable!(),
    }
}

#[derive(Debug)]
struct SourceColumn {
    name: String,
    native: String,
    data_type: WorkspaceInputType,
}

fn decimal(precision: u8, scale: u8) -> Option<WorkspaceInputType> {
    (precision > 0 && precision <= 38 && scale <= precision).then_some(WorkspaceInputType::Decimal { precision, scale })
}

fn parse_decimal(arguments: &str) -> Option<WorkspaceInputType> {
    let (precision, scale) = arguments.split_once(',')?;
    decimal(precision.trim().parse().ok()?, scale.trim().parse().ok()?)
}

fn pg_type(name: &str) -> Option<WorkspaceInputType> {
    use WorkspaceInputType::*;
    Some(match name {
        "boolean" => Boolean,
        "smallint" => Int16,
        "integer" => Int32,
        "bigint" => Int64,
        "real" => Float32,
        "double precision" => Float64,
        "text" | "character varying" => Text,
        "date" => Date,
        "uuid" => Uuid,
        "time without time zone" => Time,
        "timestamp without time zone" => Timestamp,
        "timestamp with time zone" => TimestampTz,
        _ if name.starts_with("character varying(") => Text,
        _ if name.starts_with("time(") && name.ends_with(" without time zone") => Time,
        _ if name.starts_with("timestamp(") && name.ends_with(" without time zone") => Timestamp,
        _ if name.starts_with("timestamp(") && name.ends_with(" with time zone") => TimestampTz,
        _ => return parse_decimal(name.strip_prefix("numeric(")?.strip_suffix(')')?),
    })
}

fn clickhouse_type(mut name: &str) -> Option<WorkspaceInputType> {
    use WorkspaceInputType::*;
    while let Some(inner) = name.strip_prefix("Nullable(").or_else(|| name.strip_prefix("LowCardinality(")) {
        name = inner.strip_suffix(')')?;
    }
    Some(match name {
        "Bool" => Boolean,
        "Int8" => Int8,
        "Int16" => Int16,
        "Int32" => Int32,
        "Int64" => Int64,
        "UInt8" => UInt8,
        "UInt16" => UInt16,
        "UInt32" => UInt32,
        "UInt64" => UInt64,
        "Float32" => Float32,
        "Float64" => Float64,
        "String" => Text,
        "Date" | "Date32" => Date,
        "UUID" => Uuid,
        "DateTime" => TimestampTz,
        _ if name.starts_with("DateTime(") && name.ends_with(')') => TimestampTz,
        _ if name.starts_with("DateTime64(") => {
            let arguments = name.strip_prefix("DateTime64(")?.strip_suffix(')')?;
            if arguments.split(',').next()?.trim().parse::<u8>().ok()? > 6 {
                return None;
            }
            TimestampTz
        }
        _ => return parse_decimal(name.strip_prefix("Decimal(")?.strip_suffix(')')?),
    })
}

fn source_column(driver: DbDriver, name: String, native: String) -> IdeResult<SourceColumn> {
    let data_type = match driver {
        DbDriver::Postgres => pg_type(&native),
        _ => clickhouse_type(&native),
    }
    .ok_or_else(|| IdeError::invalid(format!("Workspace column {name:?} has unsupported source type {native}")))?;
    Ok(SourceColumn { name, native, data_type })
}

fn row_limit() -> IdeError {
    IdeError::invalid("Workspace input exceeds the source row limit")
}

fn byte_limit() -> IdeError {
    IdeError::invalid("Workspace input exceeds the source byte limit")
}

fn cell_limit() -> IdeError {
    IdeError::invalid("Workspace input exceeds the source cell limit")
}

struct InputRows {
    rows: Vec<Vec<Option<String>>>,
    limits: WorkspaceInputLimits,
    bytes: usize,
}

impl InputRows {
    fn new(limits: WorkspaceInputLimits) -> Self {
        Self { rows: Vec::new(), limits, bytes: 0 }
    }

    fn new_row(&mut self) -> IdeResult<()> {
        if self.rows.len() >= self.limits.max_rows {
            return Err(row_limit());
        }
        self.bytes += std::mem::size_of::<Vec<Option<String>>>();
        if self.bytes > self.limits.max_bytes {
            return Err(byte_limit());
        }
        Ok(())
    }

    fn cell(&mut self, value: Option<&str>, data_type: WorkspaceInputType) -> IdeResult<()> {
        let bytes = value.map_or(0, str::len);
        if bytes > self.limits.max_cell_bytes {
            return Err(cell_limit());
        }
        // Charge the field allocation even for SQL NULL and empty strings.
        self.bytes += std::mem::size_of::<Option<String>>() + bytes;
        if self.bytes > self.limits.max_bytes {
            return Err(byte_limit());
        }
        if matches!(data_type, WorkspaceInputType::Decimal { .. })
            && value.is_some_and(|v| v.contains(|ch: char| ch.is_ascii_alphabetic()))
        {
            return Err(IdeError::invalid("Workspace decimals must be finite"));
        }
        Ok(())
    }

    fn finish(self, columns: Vec<SourceColumn>) -> WorkspaceInput {
        WorkspaceInput {
            columns: columns
                .into_iter()
                .map(|SourceColumn { name, data_type, .. }| WorkspaceInputColumn { name, data_type })
                .collect(),
            rows: self.rows,
        }
    }
}

fn require_columns(columns: &[SourceColumn]) -> IdeResult<()> {
    if columns.is_empty() {
        return Err(IdeError::invalid("Workspace input must be a readable native table with columns"));
    }
    if columns.len() > MAX_COLUMNS {
        return Err(IdeError::invalid("Workspace input exceeds the source column limit"));
    }
    Ok(())
}

const PG_COLUMNS: &str = "
SELECT a.attname::pg_catalog.text,
       CASE WHEN t.typnamespace = 'pg_catalog'::pg_catalog.regnamespace
            THEN pg_catalog.format_type(t.oid, a.atttypmod)
            ELSE 'user-defined ' || t.typname::pg_catalog.text END
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid
JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid
WHERE n.nspname::pg_catalog.text = $1 AND c.relname::pg_catalog.text = $2
  AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum LIMIT $3";

pub(crate) async fn read_postgres(
    conn: &mut PgConnection,
    request: &WorkspaceInputRequest,
) -> IdeResult<WorkspaceInput> {
    sqlx::raw_sql(
        "SET LOCAL DateStyle TO 'ISO, YMD'; SET LOCAL TimeZone TO 'UTC'; SET LOCAL extra_float_digits TO 3; \
         SET LOCAL search_path TO pg_catalog; \
         SELECT pg_catalog.set_config('statement_timeout', \
             COALESCE(NULLIF(LEAST(setting::integer, 20000), 0), 20000)::text, true) \
         FROM pg_catalog.pg_settings WHERE name = 'statement_timeout'",
    )
    .execute(&mut *conn)
    .await
    .map_err(db_err)?;
    let native_table = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (
            SELECT 1 FROM pg_catalog.pg_class AS c
            JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
            WHERE n.nspname::text = $1 AND c.relname::text = $2 AND c.relkind IN ('r', 'p')
        )",
    )
    .bind(&request.schema)
    .bind(&request.table)
    .persistent(false)
    .fetch_one(&mut *conn)
    .await
    .map_err(db_err)?;
    if !native_table {
        return Err(IdeError::invalid("Workspace input must be a readable native table with columns"));
    }
    let table = sql::qualified(DbDriver::Postgres, &request.schema, &request.table);
    let lock = format!("LOCK TABLE ONLY {table} IN ACCESS SHARE MODE");
    sqlx::raw_sql(sqlx::AssertSqlSafe(lock)).execute(&mut *conn).await.map_err(db_err)?;
    let mut columns = Vec::new();
    let mut stream = sqlx::query(PG_COLUMNS)
        .bind(&request.schema)
        .bind(&request.table)
        .bind((MAX_COLUMNS + 1) as i64)
        .persistent(false)
        .fetch(&mut *conn);
    while let Some(row) = stream.try_next().await.map_err(db_err)? {
        columns.push(source_column(
            DbDriver::Postgres,
            row.try_get(0).map_err(db_err)?,
            row.try_get(1).map_err(db_err)?,
        )?);
    }
    drop(stream);
    require_columns(&columns)?;
    let projection: Vec<_> = columns
        .iter()
        .map(|c| format!("t.{}::pg_catalog.text", sql::quote_ident(DbDriver::Postgres, &c.name)))
        .collect();
    let limits = request.limits;
    let statement = bounded_select(DbDriver::Postgres, &table, &projection, &columns, limits);
    let mut rows = InputRows::new(limits);
    let mut stream = sqlx::raw_sql(sqlx::AssertSqlSafe(statement)).fetch(&mut *conn);
    while let Some(row) = stream.try_next().await.map_err(db_err)? {
        rows.new_row()?;
        let status: &str = row.try_get_unchecked(columns.len()).map_err(db_err)?;
        check_row_status(status)?;
        let mut values = Vec::with_capacity(columns.len());
        for (index, column) in columns.iter().enumerate() {
            let value: Option<&str> = row.try_get(index).map_err(db_err)?;
            rows.cell(value, column.data_type)?;
            let value = value.map(|value| pg_temporal(value, column.data_type)).transpose()?;
            values.push(value.map(Cow::into_owned));
        }
        rows.rows.push(values);
    }
    Ok(rows.finish(columns))
}

fn pg_temporal(value: &str, kind: WorkspaceInputType) -> IdeResult<Cow<'_, str>> {
    use WorkspaceInputType::*;
    if !matches!(kind, Date | Timestamp | TimestampTz) || matches!(value, "infinity" | "-infinity") {
        return Ok(Cow::Borrowed(value));
    }
    let Some((year, rest)) = value.split_once('-') else {
        return Err(IdeError::invalid("Invalid PostgreSQL workspace temporal value"));
    };
    if let Some(rest) = rest.strip_suffix(" BC") {
        let year = year.parse::<i32>().map_err(|_| IdeError::invalid("Invalid PostgreSQL workspace year"))?;
        // DuckDB takes an astronomical year for BCE values, where 1 BC is year zero.
        return Ok(Cow::Owned(if year == 1 { format!("0000-{rest}") } else { format!("-{:04}-{rest}", year - 1) }));
    }
    if matches!(kind, Timestamp | TimestampTz) && year.len() >= 6 && year >= "294247" {
        return Err(IdeError::invalid("PostgreSQL workspace timestamp is outside the supported range"));
    }
    Ok(Cow::Borrowed(value))
}

fn check_row_status(status: &str) -> IdeResult<()> {
    match status {
        "0" => Ok(()),
        "1" => Err(cell_limit()),
        "2" => Err(byte_limit()),
        "3" => Err(IdeError::invalid("Workspace input contains a ClickHouse string that is not valid UTF-8")),
        "4" => Err(IdeError::invalid("Workspace input table types changed during the read")),
        _ => Err(IdeError::invalid("Invalid workspace source row status")),
    }
}

// Return a bounded status row in place of a wide value. SQL NULL stays distinct from an empty
// string. The aggregate byte budget is enforced again incrementally as rows are received.
fn bounded_select(
    driver: DbDriver,
    table: &str,
    projection: &[String],
    columns: &[SourceColumn],
    limits: WorkspaceInputLimits,
) -> String {
    let pg = driver == DbDriver::Postgres;
    let length = if pg { "pg_catalog.octet_length" } else { "length" };
    let sizes: Vec<_> = (0..columns.len()).map(|i| format!("coalesce({length}(input.v{i}), 0)")).collect();
    let oversized = sizes.iter().map(|s| format!("{s} > {}", limits.max_cell_bytes)).collect::<Vec<_>>().join(" OR ");
    let row_size = sizes.join(" + ");
    let overhead = std::mem::size_of::<Vec<Option<String>>>() + columns.len() * std::mem::size_of::<Option<String>>();
    let mut status =
        format!("CASE WHEN {oversized} THEN '1' WHEN {row_size} + {overhead} > {} THEN '2'", limits.max_bytes);
    let mut values = projection.iter().enumerate().map(|(i, p)| format!("{p} AS v{i}")).collect::<Vec<_>>().join(", ");
    if !pg {
        let invalid =
            (0..columns.len()).map(|i| format!("NOT isValidUTF8(coalesce(input.v{i}, ''))")).collect::<Vec<_>>();
        let mismatch = columns
            .iter()
            .map(|c| {
                let column = sql::quote_ident(driver, &c.name);
                let native = sql::quote_literal(driver, &c.native);
                format!("toTypeName(t.{column}) != {native}")
            })
            .collect::<Vec<_>>();
        write!(values, ", ({}) AS ws_mismatch", mismatch.join(" OR ")).unwrap();
        write!(status, " WHEN {} THEN '3' WHEN input.ws_mismatch THEN '4'", invalid.join(" OR ")).unwrap();
    }
    status.push_str(" ELSE '0' END");
    let bounded = (0..columns.len())
        .map(|i| format!("CASE WHEN checked.row_status = '0' THEN checked.v{i} ELSE NULL END AS v{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let final_status =
        format!("CASE WHEN tally.running_bytes > {} THEN '2' ELSE tally.row_status END", limits.max_bytes);
    let fields = (0..columns.len())
        .map(|i| format!("CASE WHEN ({final_status}) = '0' THEN tally.v{i} ELSE NULL END AS v{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let guard = if pg { String::new() } else { format!("WHERE {CLICKHOUSE_READ_CHECK}") };
    format!(
        "SELECT {fields}, {final_status} AS ws_status
         FROM (
             SELECT bounded.*, sum(row_bytes) OVER (ROWS UNBOUNDED PRECEDING) AS running_bytes
             FROM (
                 SELECT {bounded}, checked.row_status,
                        CASE WHEN checked.row_status = '0' THEN checked.row_bytes ELSE 0 END AS row_bytes
                 FROM (
                     SELECT input.*, {status} AS row_status, {row_size} + {overhead} AS row_bytes
                     FROM (SELECT {values} FROM {table} AS t {guard} LIMIT {}) AS input
                 ) AS checked
             ) AS bounded
         ) AS tally",
        limits.max_rows + 1
    )
}

type RawValue = serde_json::value::RawValue;

struct ClickhouseLines {
    pending: Vec<u8>,
    max_line: usize,
    headers: usize,
    width: usize,
}

impl ClickhouseLines {
    fn new(width: usize, max_line: usize) -> Self {
        Self { pending: Vec::new(), max_line: max_line.max(16_384), headers: 0, width }
    }

    fn push(&mut self, mut chunk: &[u8], row: &mut impl FnMut(Vec<&RawValue>) -> IdeResult<()>) -> IdeResult<()> {
        while let Some(end) = chunk.iter().position(|&b| b == b'\n') {
            let line = &chunk[..end];
            self.check_length(line.len())?;
            if self.pending.is_empty() {
                self.line(line, row)?;
            } else {
                self.pending.extend_from_slice(line);
                let pending = std::mem::take(&mut self.pending);
                self.line(&pending, row)?;
            }
            chunk = &chunk[end + 1..];
        }
        self.check_length(chunk.len())?;
        self.pending.extend_from_slice(chunk);
        Ok(())
    }

    fn check_length(&self, additional: usize) -> IdeResult<()> {
        if self.pending.len() + additional > self.max_line {
            return Err(byte_limit());
        }
        Ok(())
    }

    fn line(&mut self, line: &[u8], row: &mut impl FnMut(Vec<&RawValue>) -> IdeResult<()>) -> IdeResult<()> {
        let values: Vec<&RawValue> = serde_json::from_slice(line)
            .map_err(|_| IdeError::invalid("ClickHouse interrupted the workspace read or sent an invalid response"))?;
        if values.len() != self.width {
            return Err(IdeError::invalid("ClickHouse response width does not match the workspace table"));
        }
        if self.headers < 2 {
            if values.iter().any(|v| !v.get().starts_with('"')) {
                return Err(IdeError::invalid("Invalid ClickHouse workspace response header"));
            }
            self.headers += 1;
            return Ok(());
        }
        row(values)
    }

    fn finish(&self) -> IdeResult<()> {
        if self.headers != 2 || !self.pending.is_empty() {
            return Err(IdeError::invalid("ClickHouse workspace response ended before a complete result"));
        }
        Ok(())
    }
}

fn json_string(raw: &RawValue) -> IdeResult<String> {
    serde_json::from_str(raw.get()).map_err(|_| IdeError::invalid("Invalid ClickHouse workspace text field"))
}

const CLICKHOUSE_READ_CHECK: &str = "throwIf(
    getSetting('readonly') != 1 OR
    getSetting('read_overflow_mode') != 'throw' OR
    getSetting('result_overflow_mode') != 'throw' OR
    getSetting('timeout_overflow_mode') != 'throw',
    'Workspace requires ClickHouse read-only mode and overflow modes that throw'
) = 0";

async fn read_clickhouse(
    pool: &crate::clickhouse::ClickhousePool,
    request: &WorkspaceInputRequest,
    cancel: &CancellationToken,
) -> IdeResult<WorkspaceInput> {
    let driver = DbDriver::Clickhouse;
    let database = sql::quote_literal(driver, &request.database);
    let table = sql::quote_literal(driver, &request.table);
    let catalog = format!(
        "SELECT name, type FROM system.columns
         WHERE database = {database} AND table = {table}
           AND (
               SELECT count() FROM system.tables
               WHERE database = {database} AND name = {table}
                 AND (endsWith(engine, 'MergeTree') OR engine IN ('Memory', 'Log', 'TinyLog', 'StripeLog', 'Null'))
           ) > 0
           AND {CLICKHOUSE_READ_CHECK}
         ORDER BY position LIMIT {}",
        MAX_COLUMNS + 1,
    );
    let mut columns = Vec::new();
    let mut parser = ClickhouseLines::new(2, 16_384);
    pool.workspace_rows(&catalog, MAX_COLUMNS + 1, 1_048_576, cancel, |chunk| {
        parser.push(chunk, &mut |row| {
            if columns.len() >= MAX_COLUMNS {
                return Err(IdeError::invalid("Workspace input exceeds the source column limit"));
            }
            columns.push(source_column(driver, json_string(row[0])?, json_string(row[1])?)?);
            Ok(())
        })
    })
    .await?;
    parser.finish()?;
    require_columns(&columns)?;
    let table = sql::qualified(driver, &request.database, &request.table);
    let limits = request.limits;
    let projection: Vec<_> = columns
        .iter()
        .map(|col| {
            let name = sql::quote_ident(driver, &col.name);
            if col.data_type == WorkspaceInputType::TimestampTz {
                format!("concat(toString(t.{name}, 'UTC'), '+00:00')")
            } else {
                format!("toString(t.{name})")
            }
        })
        .collect();
    let query = bounded_select(driver, &table, &projection, &columns, limits);
    let mut rows = InputRows::new(limits);
    let wire_limit = 6 * limits.max_bytes + 16_384;
    let mut parser = ClickhouseLines::new(columns.len() + 1, wire_limit);
    pool.workspace_rows(&query, limits.max_rows + 1, wire_limit, cancel, |chunk| {
        parser.push(chunk, &mut |row| {
            rows.new_row()?;
            check_row_status(&json_string(row[columns.len()])?)?;
            let mut values = Vec::with_capacity(columns.len());
            for (raw, column) in row.into_iter().zip(&columns) {
                let value = if raw.get() == "null" {
                    None
                } else {
                    if raw.get().len() > 6 * limits.max_cell_bytes + 2 {
                        return Err(cell_limit());
                    }
                    Some(json_string(raw)?)
                };
                rows.cell(value.as_deref(), column.data_type)?;
                values.push(value);
            }
            rows.rows.push(values);
            Ok(())
        })
    })
    .await?;
    parser.finish()?;
    Ok(rows.finish(columns))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DataSource;
    use std::sync::Arc;

    const LIMITS: WorkspaceInputLimits = WorkspaceInputLimits { max_rows: 10, max_cell_bytes: 128, max_bytes: 4096 };

    #[test]
    fn source_types_cannot_silently_lose_precision() {
        let decimal = WorkspaceInputType::Decimal { precision: 32, scale: 6 };
        assert_eq!(pg_type("numeric(32,6)"), Some(decimal));
        assert_eq!(clickhouse_type("Nullable(Decimal(32, 6))"), Some(decimal));
        for name in ["numeric", "numeric(39,4)", "numeric(18,-8)", "time with time zone", "jsonb"] {
            assert_eq!(pg_type(name), None, "{name}");
        }
        for name in ["Decimal(39, 5)", "DateTime64(9, 'UTC')", "Array(String)", "Int128"] {
            assert_eq!(clickhouse_type(name), None, "{name}");
        }
    }

    #[test]
    fn postgres_temporal_values_keep_their_era() -> IdeResult<()> {
        use WorkspaceInputType::*;
        assert_eq!(pg_temporal("0044-03-15 BC", Date)?, "-0043-03-15");
        assert_eq!(pg_temporal("0001-03-15 00:00:00+00 BC", TimestampTz)?, "0000-03-15 00:00:00+00");
        assert_eq!(pg_temporal("infinity", Timestamp)?, "infinity");
        assert!(pg_temporal("294276-12-31 23:59:59.999999", Timestamp).is_err());
        Ok(())
    }

    #[test]
    fn clickhouse_chunks_keep_exact_strings_and_require_complete_protocol() -> IdeResult<()> {
        let mut parser = ClickhouseLines::new(2, 1_024);
        let mut entries = Vec::new();
        let mut push = |cells: Vec<&RawValue>| {
            entries.push((json_string(cells[0])?, cells[1].get().to_owned()));
            Ok(())
        };
        parser.push(b"[\"v0\",\"v1\"]\n[\"String\",\"String\"]\n[\"900719925", &mut push)?;
        parser.push(b"4740993\",null]\n[\"a,b\\\"c\\nd\",\"\" ]\n", &mut push)?;
        parser.finish()?;
        assert_eq!(
            entries,
            [("9007199254740993".to_owned(), "null".to_owned()), ("a,b\"c\nd".to_owned(), "\"\"".to_owned())],
        );
        parser.push(b"[\"partial\"", &mut |_| Ok(()))?;
        assert!(parser.finish().is_err());
        assert!(parser.push(&vec![b'x'; 16_384], &mut |_| Ok(())).is_err());
        Ok(())
    }

    #[tokio::test]
    #[ignore = "run bash crates/ide-db/tests/fixtures/workspace.sh for disposable PG17/CH25.8"]
    async fn native_workspace_sources_are_exact_and_fail_on_limits() -> IdeResult<()> {
        ide_ssh::secrets::testing::use_memory_store();
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let ssh = Arc::new(ide_ssh::SshManager::new(root.join("ssh-passwords.json")));
        let db = DbManager::new(root.to_path_buf(), root.join("passwords.json"), root.join("history.json"), ssh)
            .with_global_sources(root.join("global"));
        let postgres = std::env::var("WORKSPACE_PG_PORT").unwrap().parse().unwrap();
        let clickhouse = std::env::var("WORKSPACE_CH_PORT").unwrap().parse().unwrap();
        db.save_sources(vec![
            DataSource {
                id: "postgres".into(),
                name: "postgres".into(),
                driver: DbDriver::Postgres,
                url_only: true,
                url: format!("postgresql://postgres@127.0.0.1:{postgres}/postgres"),
                ..Default::default()
            },
            DataSource {
                id: "clickhouse".into(),
                name: "clickhouse".into(),
                driver: DbDriver::Clickhouse,
                host: "127.0.0.1".into(),
                database: "default".into(),
                user: std::env::var("WORKSPACE_CH_USER").unwrap_or_else(|_| "default".into()),
                port: Some(clickhouse),
                ..Default::default()
            },
        ])
        .await?;
        let cancel = CancellationToken::new();
        for (id, database, schema) in [("postgres", "", "public"), ("clickhouse", "default", "default")] {
            let request = WorkspaceInputRequest {
                source_id: id.into(),
                database: database.into(),
                schema: schema.into(),
                table: "exact data".into(),
                limits: LIMITS,
            };
            let input = read_table(&db, &request, &cancel).await?;
            assert_eq!(input.columns[0].data_type, WorkspaceInputType::Decimal { precision: 32, scale: 6 });
            assert_eq!(input.columns[1].data_type, WorkspaceInputType::Int64);
            assert_eq!(input.columns[2].data_type, WorkspaceInputType::TimestampTz);
            assert_eq!(input.columns[3].data_type, WorkspaceInputType::Text);
            assert_eq!(input.columns[0].name, "exact key");
            let first = input.rows.iter().find(|r| r[1].as_deref() == Some("9007199254740993")).unwrap();
            let second = input.rows.iter().find(|r| r[1].as_deref() == Some("9007199254740994")).unwrap();
            assert_eq!(first[0].as_deref(), Some("100000000000000000001.000001"));
            assert!(first[2].as_deref().unwrap().starts_with("2025-01-03 04:05:06.123456"));
            assert_eq!(first[3].as_deref(), Some("a,b\"c\nd"));
            assert_eq!(second[2], None);
            assert_eq!(second[3].as_deref(), Some(""));
            assert!(input.rows.iter().any(|row| row[3].is_none()));
            let empty =
                read_table(&db, &WorkspaceInputRequest { table: "empty data".into(), ..request.clone() }, &cancel)
                    .await?;
            assert_eq!(empty.columns, input.columns);
            assert!(empty.rows.is_empty());
            for (limits, message) in [
                (WorkspaceInputLimits { max_rows: 1, ..LIMITS }, "row limit"),
                (WorkspaceInputLimits { max_cell_bytes: 8, ..LIMITS }, "cell limit"),
                (WorkspaceInputLimits { max_bytes: 150, ..LIMITS }, "byte limit"),
                (WorkspaceInputLimits { max_bytes: 250, ..LIMITS }, "byte limit"),
            ] {
                let limited = WorkspaceInputRequest { limits, ..request.clone() };
                let err = read_table(&db, &limited, &cancel).await.unwrap_err();
                assert!(err.message.contains(message), "{id}: {err}");
            }
            for (table, message) in
                [("unsupported data", "unsupported source type"), ("fixture view", "readable native table")]
            {
                let request = WorkspaceInputRequest { table: table.into(), ..request.clone() };
                let err = read_table(&db, &request, &cancel).await.unwrap_err();
                assert!(err.message.contains(message), "{id}: {err}");
            }
            assert!(!db.is_connected(id), "the workspace must not open or use a console pool");
        }
        let has_duckdb = if let Ok(jar) = std::env::var("DUCKDB_JDBC_JAR") {
            db.save_jdbc_driver(crate::DbJdbcDriver {
                id: "duck".into(),
                name: "DuckDB".into(),
                vendor: Some("duckdb".into()),
                jars: vec![jar],
                class_name: "org.duckdb.DuckDBDriver".into(),
                url_template: "jdbc:duckdb:".into(),
            })?;
            true
        } else {
            false
        };
        use sqlx::{Connection, postgres::PgConnectOptions};
        let options =
            PgConnectOptions::new().host("127.0.0.1").port(postgres).database("postgres").username("postgres");
        let mut lock = PgConnection::connect_with(&options).await.map_err(db_err)?;
        let mut observer = PgConnection::connect_with(&options).await.map_err(db_err)?;
        sqlx::raw_sql("BEGIN; LOCK TABLE public.\"exact data\" IN ACCESS EXCLUSIVE MODE")
            .execute(&mut lock)
            .await
            .map_err(db_err)?;
        let blocked = WorkspaceInputRequest {
            source_id: "postgres".into(),
            database: "postgres".into(),
            schema: "public".into(),
            table: "exact data".into(),
            limits: LIMITS,
        };
        let ch = WorkspaceInputRequest {
            source_id: "clickhouse".into(),
            database: "default".into(),
            schema: "default".into(),
            ..blocked.clone()
        };
        let blocked_cancel = CancellationToken::new();
        let interrupt = async {
            let pending = async {
                loop {
                    let pid: Option<i32> = sqlx::query_scalar(
                        "SELECT pid FROM pg_catalog.pg_stat_activity
                         WHERE wait_event_type = 'Lock' AND query LIKE 'LOCK TABLE ONLY %' LIMIT 1",
                    )
                    .fetch_optional(&mut observer)
                    .await
                    .map_err(db_err)?;
                    if let Some(pid) = pid {
                        return Ok::<_, IdeError>(pid);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            };
            let blocked_query = tokio::time::timeout(std::time::Duration::from_secs(8), pending).await;
            blocked_cancel.cancel();
            blocked_query.map_err(|_| IdeError::internal("Workspace did not reach its source lock"))?
        };
        let blocked_run = async {
            if has_duckdb {
                db.workspace_join("duck", [&blocked, &ch], ["exact key", "exact key"], &blocked_cancel).await.map(drop)
            } else {
                read_table(&db, &blocked, &blocked_cancel).await.map(drop)
            }
        };
        let (result, interrupted) = tokio::join!(blocked_run, interrupt);
        let pid = interrupted.unwrap_or_else(|error| panic!("{error}; workspace returned {result:?}"));
        assert_eq!(result.unwrap_err().kind, ide_core::error::ErrorKind::Cancelled);
        let drained = async {
            loop {
                let waiting: bool = sqlx::query_scalar(
                    "SELECT EXISTS (
                        SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'
                    )",
                )
                .bind(pid)
                .fetch_one(&mut observer)
                .await
                .map_err(db_err)?;
                if !waiting {
                    return Ok::<_, IdeError>(());
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), drained)
            .await
            .expect("workspace released its server waiter before the fixture released the lock")?;
        sqlx::raw_sql("ROLLBACK").execute(&mut lock).await.map_err(db_err)?;
        let unsigned = WorkspaceInputRequest { table: "unsigned data".into(), ..ch.clone() };
        let input = read_table(&db, &unsigned, &cancel).await?;
        assert_eq!(input.columns[0].data_type, WorkspaceInputType::UInt64);
        assert!(input.rows.iter().any(|row| row[0].as_deref() == Some("18446744073709551615")));
        if has_duckdb {
            let mismatch = db.workspace_join("duck", [&blocked, &ch], ["id", "label"], &cancel).await.unwrap_err();
            assert!(mismatch.message.contains("type"), "{mismatch}");
            let mixed = db.workspace_join("duck", [&blocked, &unsigned], ["id", "id"], &cancel).await?;
            assert_eq!(mixed.rows.len(), 1);
            assert_eq!(mixed.rows[0][1].as_deref(), Some("9007199254740993"));
            assert_eq!(mixed.rows[0][4].as_deref(), Some("9007199254740993"));
            let pg = blocked;
            let result = db.workspace_join("duck", [&pg, &ch], ["exact key", "exact key"], &cancel).await?;
            assert_eq!(result.rows.len(), 2);
            for row in result.rows {
                assert_eq!(row[0], row[4]);
                assert_eq!(row[1], row[5]);
                assert_eq!(row[2], row[6]);
                assert_eq!(row[3], row[7]);
                let id = row[1].as_deref().unwrap();
                if id == "9007199254740993" {
                    assert_eq!(row[0].as_deref(), Some("100000000000000000001.000001"));
                    assert!(row[2].as_deref().unwrap().contains(".123456"));
                    assert_eq!(row[3].as_deref(), Some("a,b\"c\nd"));
                } else {
                    assert_eq!(id, "9007199254740994");
                    assert_eq!(row[0].as_deref(), Some("100000000000000000002.000001"));
                    assert_eq!(row[2], None);
                    assert_eq!(row[3].as_deref(), Some(""));
                    assert_eq!(row[6], None);
                }
            }
        }
        Ok(())
    }
}
