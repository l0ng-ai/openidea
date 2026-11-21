//! Database commands shared by the desktop shell's IPC commands and the
//! remote server ([`crate::rpc`]). `db_export_file` stays in the desktop
//! shell: its path comes from a local save dialog, so the export must land
//! on the user's machine, not the side the project runs on.
use super::Channel;
use crate::Host;
use ide_command::command;
use ide_core::{IdeError, IdeResult, IpcPath, RequestId};
use ide_db::split::SqlStatement;
use ide_db::{
    CompletionModel, DataSource, Databases, DbObjectKind, DbRowEdit, DbVisibilityChange, HistoryEntry, PlanNode,
    QueryResult, SchemaObjects, SortKey, TableDetails, TableInfo, TablePage,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

/// One statement of a console run.
#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbStatementOutcome")]
pub struct StatementOutcome {
    pub statement: SqlStatement,
    pub result: Option<QueryResult>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExecutionEvent {
    Started { index: u32 },
    Completed { index: u32, outcome: StatementOutcome },
    Done { error: Option<IdeError> },
}

#[command(trust = trusted)]
pub fn db_approve_jdbc_source(host: &Host, window: &str, source: DataSource) -> IdeResult<()> {
    host.project(window)?.db.approve_jdbc_source(&source)
}

#[command(trust = trusted)]
pub async fn db_jdbc_driver_classes(host: &Host, window: &str, jars: Vec<String>) -> IdeResult<Vec<String>> {
    host.project(window)?;
    tokio::task::spawn_blocking(move || ide_db::jdbc_driver_classes(&jars))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
}

#[command(trust = trusted)]
pub fn db_jdbc_drivers(host: &Host, window: &str) -> IdeResult<Vec<ide_db::DbJdbcDriver>> {
    host.project(window)?.db.jdbc_drivers()
}

#[command(trust = trusted)]
pub fn db_save_jdbc_driver(host: &Host, window: &str, driver: ide_db::DbJdbcDriver) -> IdeResult<()> {
    host.project(window)?.db.save_jdbc_driver(driver)
}

#[command(trust = trusted)]
pub fn db_remove_jdbc_driver(host: &Host, window: &str, id: String) -> IdeResult<()> {
    host.project(window)?.db.remove_jdbc_driver(&id)
}

#[command(trust = trusted)]
pub fn db_sources(host: &Host, window: &str) -> IdeResult<Vec<DataSource>> {
    // The data sources configured for the project (the tree's roots).
    host.project(window)?.db.sources()
}

#[command(trust = trusted)]
pub async fn db_save_sources(host: &Host, window: &str, sources: Vec<DataSource>) -> IdeResult<()> {
    // Replaces the project's data sources with `sources`.
    let db = host.project(window)?.db.clone();
    db.save_sources(sources).await?;
    sources_changed(host, window)
}

#[command(trust = trusted)]
pub async fn db_save_source_visibility(
    host: &Host,
    window: &str,
    id: String,
    available: Vec<String>,
    change: DbVisibilityChange,
) -> IdeResult<()> {
    let db = host.project(window)?.db.clone();
    tokio::task::spawn_blocking(move || db.save_source_visibility(&id, &available, change))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))??;
    sources_changed(host, window)
}

fn sources_changed(host: &Host, window: &str) -> IdeResult<()> {
    let root = host.project(window)?.root.clone();
    for project in host.projects().into_iter().filter(|p| p.root == root) {
        project.sink.emit(ide_core::IdeEvent::DbSourcesChanged);
    }
    Ok(())
}

#[command(trust = trusted)]
pub async fn db_set_password(
    host: &Host,
    window: &str,
    id: String,
    password: Option<String>,
    save: bool,
) -> IdeResult<()> {
    // Remembers the password of data source `id` for the session, and in the OS
    // saved passwords when `save` (`None` forgets it).
    let db = host.project(window)?.db.clone();
    db.set_password(&id, password, save).await
}

#[command(trust = trusted)]
pub async fn db_test(
    host: &Host,
    window: &str,
    source: DataSource,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> IdeResult<String> {
    // Test Connection: connects with unsaved settings and returns the server version.
    let db = host.project(window)?.db.clone();
    db.test(&source, password, ssh_secret).await
}

/// Data Source › SSH/SSL › Test SSH Tunnel.
#[command(trust = trusted)]
pub async fn db_test_tunnel(
    host: &Host,
    window: &str,
    source: DataSource,
    ssh_secret: Option<String>,
) -> IdeResult<String> {
    // Checks the SSH tunnel of `source` alone: SSH login and the SSH host reaching the database.
    let db = host.project(window)?.db.clone();
    db.test_tunnel(&source, ssh_secret).await
}

#[command(trust = trusted)]
pub async fn db_set_ssh_secret(
    host: &Host,
    window: &str,
    id: String,
    secret: Option<String>,
    save: bool,
) -> IdeResult<()> {
    // Remembers the SSH password / key passphrase of a data source (see `db_set_password`).
    let db = host.project(window)?.db.clone();
    db.set_ssh_secret(&id, secret, save).await
}

#[command(trust = trusted)]
pub async fn db_trust_ssh_host(host: &Host, window: &str, id: String) -> IdeResult<()> {
    // Trusts the SSH host key that made the last connection of `id` fail with
    // "Unknown SSH host key" (records it in `~/.ssh/known_hosts`).
    let db = host.project(window)?.db.clone();
    db.trust_ssh_host(&id).await
}

#[command(trust = trusted)]
pub fn db_connected(host: &Host, window: &str) -> IdeResult<Vec<String>> {
    // The data sources with an open connection.
    Ok(host.project(window)?.db.connected())
}

#[command(trust = trusted)]
pub async fn db_connect(host: &Host, window: &str, id: String) -> IdeResult<()> {
    // Connects (fails with `permissionDenied` when the password is missing or wrong).
    let db = host.project(window)?.db.clone();
    db.pool(&id).await.map(|_| ())
}

#[command(trust = trusted)]
pub async fn db_set_manual_commit(host: &Host, window: &str, id: String, manual: bool) -> IdeResult<()> {
    // Switches a data source between auto-commit and manual commit (leaving
    // manual mode rolls back what was not committed).
    let db = host.project(window)?.db.clone();
    db.set_manual_commit(&id, manual).await
}

#[command(trust = trusted)]
pub async fn db_finish_transaction(host: &Host, window: &str, id: String, commit: bool) -> IdeResult<()> {
    // Commits or rolls back the open transaction of a manual-commit data source.
    let db = host.project(window)?.db.clone();
    db.finish_transaction(&id, commit).await
}

#[command(trust = trusted)]
pub async fn db_disconnect(host: &Host, window: &str, id: String) -> IdeResult<()> {
    // Closes the connection of data source `id`.
    let db = host.project(window)?.db.clone();
    db.disconnect(&id).await;
    Ok(())
}

#[command(trust = trusted)]
pub async fn db_create_database(
    host: &Host,
    window: &str,
    id: String,
    template: String,
    statement: String,
) -> IdeResult<()> {
    // Creates a database on the server of data source `id` with `statement`, copied from `template` (New › Database).
    let db = host.project(window)?.db.clone();
    db.create_database(&id, &template, &statement).await
}

#[command(trust = trusted)]
pub async fn db_drop_database(
    host: &Host,
    window: &str,
    id: String,
    database: String,
    statement: String,
) -> IdeResult<()> {
    // Drops `database` of the server of data source `id` with `statement` (Drop… on a database node).
    let db = host.project(window)?.db.clone();
    db.drop_database(&id, &database, &statement).await
}

#[command(trust = trusted)]
pub async fn db_databases(host: &Host, window: &str, id: String) -> IdeResult<Databases> {
    // Databases of the server of data source `id` (PostgreSQL); connect to one as `<id>:<database>`.
    let db = host.project(window)?.db.clone();
    db.databases(&id).await
}

#[command(trust = trusted)]
pub async fn db_database_catalog(
    host: &Host,
    window: &str,
    id: String,
    database: String,
) -> IdeResult<Vec<ide_db::CatalogSchema>> {
    // The schemas of `database` of Snowflake data source `id` with their tables and views.
    let db = host.project(window)?.db.clone();
    db.database_catalog(&id, &database).await
}

#[command(trust = trusted)]
pub async fn db_saved_catalog(host: &Host, window: &str, id: String) -> IdeResult<Option<ide_db::SourceCatalog>> {
    // What earlier introspection of data source `id` saved; the data source is not connected to.
    let db = host.project(window)?.db.clone();
    db.saved_catalog(&id).await
}

#[command(trust = trusted)]
pub async fn db_retain_catalog(host: &Host, window: &str, id: String, databases: Vec<String>) -> IdeResult<()> {
    // Drops the saved databases of data source `id` that are not in `databases` any more.
    let db = host.project(window)?.db.clone();
    db.retain_catalog(&id, databases).await
}

#[command(trust = trusted)]
pub async fn db_session_context(host: &Host, window: &str, id: String) -> IdeResult<ide_db::SessionContext> {
    // The warehouse and role of the Snowflake session of data source `id`, and what it may switch to.
    let db = host.project(window)?.db.clone();
    db.session_context(&id).await
}

#[command(trust = trusted)]
pub async fn db_schemas(host: &Host, window: &str, id: String) -> IdeResult<Vec<String>> {
    // The schemas of data source `id`.
    let db = host.project(window)?.db.clone();
    db.schemas(&id).await
}

#[command(trust = trusted)]
pub async fn db_tables(host: &Host, window: &str, id: String, schema: String) -> IdeResult<Vec<TableInfo>> {
    // The tables and views of `schema`.
    let db = host.project(window)?.db.clone();
    db.tables(&id, &schema).await
}

#[command(trust = trusted)]
pub async fn db_table_details(
    host: &Host,
    window: &str,
    id: String,
    schema: String,
    table: String,
) -> IdeResult<TableDetails> {
    // Columns, keys and indexes of `table`.
    let db = host.project(window)?.db.clone();
    db.table_details(&id, &schema, &table).await
}

#[command(trust = trusted)]
pub async fn db_ddl(host: &Host, window: &str, id: String, schema: String, table: String) -> IdeResult<String> {
    // The DDL of table or view `table` (Go to DDL, Generate DDL).
    let db = host.project(window)?.db.clone();
    db.ddl(&id, &schema, &table).await
}

#[command(trust = trusted)]
pub async fn db_schema_objects(host: &Host, window: &str, id: String, schema: String) -> IdeResult<SchemaObjects> {
    // The routines and sequences of `schema` (the tree's `routines` / `sequences`).
    let db = host.project(window)?.db.clone();
    db.schema_objects(&id, &schema).await
}

#[command(trust = trusted)]
pub async fn db_object_ddl(
    host: &Host,
    window: &str,
    id: String,
    schema: String,
    kind: DbObjectKind,
    name: String,
) -> IdeResult<String> {
    // The definition of a routine, trigger or sequence (Go to DDL, Quick Documentation).
    let db = host.project(window)?.db.clone();
    db.object_ddl(&id, &schema, kind, &name).await
}

#[command(trust = trusted)]
pub async fn db_explain(
    host: &Host,
    window: &str,
    request: RequestId,
    id: String,
    statement: String,
    schema: Option<String>,
) -> IdeResult<Vec<PlanNode>> {
    // Explain Plan: the execution plan of `statement` on `id`, without running it.
    let db = host.project(window)?.db.clone();
    let cancel = host.begin_request(request);
    let result = db.explain(&id, &statement, &cancel, schema.as_deref()).await;
    host.end_request(request);
    result
}

#[command(trust = trusted)]
pub async fn db_history(host: &Host, window: &str, id: String) -> IdeResult<Vec<HistoryEntry>> {
    // The statements data source `id` ran, newest first (Browse Query History).
    let db = host.project(window)?.db.clone();
    db.history(&id).await
}

#[command(trust = trusted)]
pub async fn db_remove_history(host: &Host, window: &str, id: String, texts: Option<Vec<String>>) -> IdeResult<()> {
    // Removes statements from the query history of `id` (`None`: all of them).
    let db = host.project(window)?.db.clone();
    db.remove_history(&id, texts).await
}

#[command(trust = trusted)]
pub async fn db_completion(host: &Host, window: &str, id: String) -> IdeResult<CompletionModel> {
    // Tables, columns and foreign keys for SQL completion.
    let db = host.project(window)?.db.clone();
    db.completion(&id).await
}

#[command(trust = trusted)]
pub fn db_statements(
    host: &Host,
    window: &str,
    id: String,
    text: String,
    from: u32,
    to: u32,
) -> IdeResult<Vec<SqlStatement>> {
    // Statements a console runs: the selection's (`from < to`) or the one at the caret (`from`).
    let driver = host.project(window)?.db.source(&id)?.driver;
    Ok(if from < to {
        ide_db::split::statements_in(&text, from, to, driver)
    } else {
        ide_db::split::statement_at(&text, from, driver).into_iter().collect()
    })
}

#[allow(clippy::too_many_arguments)]
#[command(trust = trusted)]
pub async fn db_execute(
    host: &Host,
    window: &str,
    request: RequestId,
    id: String,
    statements: Vec<SqlStatement>,
    // Clients before pagination send no `skip`.
    #[default] skip: u32,
    max_rows: u32,
    schema: Option<String>,
) -> IdeResult<Vec<StatementOutcome>> {
    let mut outcomes = Vec::new();
    execute_statements(host, window, request, &id, statements, skip, max_rows, schema.as_deref(), |event| {
        if let ExecutionEvent::Completed { outcome, .. } = event {
            outcomes.push(outcome);
        }
        Ok(())
    })
    .await?;
    Ok(outcomes)
}

#[allow(clippy::too_many_arguments)]
#[command(trust = trusted)]
pub async fn db_execute_stream(
    host: &Host,
    window: &str,
    request: RequestId,
    id: String,
    statements: Vec<SqlStatement>,
    max_rows: u32,
    schema: Option<String>,
    on_progress: Channel<ExecutionEvent>,
) -> IdeResult<()> {
    let result = execute_statements(host, window, request, &id, statements, 0, max_rows, schema.as_deref(), |event| {
        on_progress.send(event)
    })
    .await;
    // The invocation reply can reach the viewer before a large result frame.
    on_progress.send(ExecutionEvent::Done { error: result.err() })
}

/// Runs in order on one request and stops on cancellation or the first error.
#[allow(clippy::too_many_arguments)]
async fn execute_statements(
    host: &Host,
    window: &str,
    request: RequestId,
    id: &str,
    statements: Vec<SqlStatement>,
    skip: u32,
    max_rows: u32,
    schema: Option<&str>,
    mut emit: impl FnMut(ExecutionEvent) -> IdeResult<()>,
) -> IdeResult<()> {
    let db = host.project(window)?.db.clone();
    let cancel = host.begin_request(request);
    let result = async {
        for (index, statement) in statements.into_iter().enumerate() {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            emit(ExecutionEvent::Started { index: index as u32 })?;
            let outcome = match db
                .execute_from(id, &statement.text, skip as usize, max_rows.max(1) as usize, &cancel, schema)
                .await
            {
                Ok(result) => StatementOutcome { statement, result: Some(result), error: None },
                Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled => return Err(e),
                // The UI may retry a login failure only before any statement has completed.
                Err(e) if e.kind == ide_core::error::ErrorKind::PermissionDenied && index == 0 => return Err(e),
                Err(e) => StatementOutcome { statement, result: None, error: Some(e.message) },
            };
            let failed = outcome.error.is_some();
            emit(ExecutionEvent::Completed { index: index as u32, outcome })?;
            if failed {
                break;
            }
        }
        Ok(())
    }
    .await;
    host.end_request(request);
    result
}

#[allow(clippy::too_many_arguments)]
#[command(trust = trusted)]
pub async fn db_table_page(
    host: &Host,
    window: &str,
    request: RequestId,
    id: String,
    schema: String,
    table: String,
    filter: Option<String>,
    sort: Vec<SortKey>,
    offset: u32,
    limit: u32,
) -> IdeResult<TablePage> {
    // One page of the rows of `table` (the table editor).
    let db = host.project(window)?.db.clone();
    let cancel = host.begin_request(request);
    let result = db
        .table_page(&id, &schema, &table, filter.as_deref(), &sort, offset.into(), limit.max(1).into(), &cancel)
        .await;
    host.end_request(request);
    result
}

#[command(trust = trusted)]
pub async fn db_apply_edits(
    host: &Host,
    window: &str,
    id: String,
    schema: String,
    table: String,
    edits: Vec<DbRowEdit>,
) -> IdeResult<f64> {
    // Submits the table editor's changes in one transaction; returns the rows changed.
    let db = host.project(window)?.db.clone();
    Ok(db.apply_edits(&id, &schema, &table, &edits).await? as f64)
}

#[command(trust = always)]
pub fn db_console_path(host: &Host, id: String) -> IdeResult<IpcPath> {
    // The query console file of data source `id` (`<dataDir>/consoles/db/<id>/console.sql`),
    // created on first use. Consoles are files of the project, so a remote
    // window resolves it on the host the project runs on.
    let file = console_dir(host, &id)?.join("console.sql");
    if !file.exists() {
        std::fs::write(&file, "")?;
    }
    Ok(file.into())
}

/// The query consoles of data source `id`; `create` adds the next one first.
#[command(trust = always)]
pub fn db_consoles(host: &Host, id: String, create: bool) -> IdeResult<Vec<IpcPath>> {
    // The default `console.sql`, then `console_1.sql`, `console_2.sql`… in order
    // (`create`: DataGrip's New › Query Console).
    let dir = console_dir(host, &id)?;
    let default = dir.join("console.sql");
    let mut numbered: Vec<(u32, PathBuf)> = std::fs::read_dir(&dir)?
        .filter_map(|e| {
            let path = e.ok()?.path();
            let n = path.file_name()?.to_str()?.strip_prefix("console_")?.strip_suffix(".sql")?.parse().ok()?;
            Some((n, path))
        })
        .collect();
    numbered.sort();
    if create {
        // The default console comes first; once it exists, the next number.
        if !default.exists() {
            std::fs::write(&default, "")?;
        } else {
            let n = numbered.last().map_or(1, |(n, _)| n + 1);
            let file = dir.join(format!("console_{n}.sql"));
            std::fs::write(&file, "")?;
            numbered.push((n, file));
        }
    }
    let mut out: Vec<IpcPath> = Vec::new();
    if default.exists() {
        out.push(default.into());
    }
    out.extend(numbered.into_iter().map(|(_, p)| p.into()));
    Ok(out)
}

/// `<dataDir>/consoles/db/<id>`: `<id>` for the default database, `<id>.<database>` for the others.
fn console_dir(host: &Host, id: &str) -> IdeResult<PathBuf> {
    let (source, database) = ide_db::split_target(id);
    if source.is_empty() || !source.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(IdeError::invalid("invalid data source id"));
    }
    let name = match database {
        Some(db) => {
            let safe: String =
                db.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
            format!("{source}.{safe}")
        }
        None => source.to_owned(),
    };
    let dir = host.data_dir.join("consoles").join("db").join(&name);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Runs a client tool against target `id` until it exits or the request is cancelled.
/// Desktop only: the file paths come from local dialogs.
pub async fn run_tool(
    host: &Host,
    window: &str,
    request: RequestId,
    id: &str,
    executable: &std::path::Path,
    job: &ide_db::tools::DbToolJob,
    on_output: impl FnMut(Vec<ide_db::tools::ToolLine>),
) -> IdeResult<Option<i32>> {
    let db = host.project(window)?.db.clone();
    let cancel = host.begin_request(request);
    let result = db.run_tool(id, executable, job, &cancel, on_output).await;
    host.end_request(request);
    result
}

pub fn tool_preview(
    host: &Host,
    window: &str,
    id: &str,
    executable: &std::path::Path,
    job: &ide_db::tools::DbToolJob,
) -> IdeResult<String> {
    host.project(window)?.db.tool_preview(id, executable, job)
}

pub async fn server_version(host: &Host, window: &str, id: &str) -> IdeResult<u32> {
    host.project(window)?.db.server_version(id).await
}

ide_command::domain!(
    db:
    db_apply_edits,
    db_completion,
    db_connect,
    db_connected,
    db_console_path,
    db_consoles,
    db_create_database,
    db_database_catalog,
    db_databases,
    db_ddl,
    db_disconnect,
    db_drop_database,
    db_execute,
    db_execute_stream,
    db_explain,
    db_finish_transaction,
    db_history,
    db_jdbc_driver_classes,
    db_jdbc_drivers,
    db_approve_jdbc_source,
    db_save_jdbc_driver,
    db_remove_jdbc_driver,
    db_object_ddl,
    db_remove_history,
    db_retain_catalog,
    db_save_source_visibility,
    db_save_sources,
    db_saved_catalog,
    db_schema_objects,
    db_schemas,
    db_session_context,
    db_set_manual_commit,
    db_set_password,
    db_set_ssh_secret,
    db_sources,
    db_statements,
    db_table_details,
    db_table_page,
    db_tables,
    db_test,
    db_test_tunnel,
    db_trust_ssh_host,
);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HostConfig;
    use ide_db::DbDriver;
    use std::sync::Arc;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_reporting_error_stops_the_batch_and_releases_the_request() {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir(&root).unwrap();
        let host = Host::new(HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("local"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(|_| {})),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        });
        let window = "main";
        host.open_project(window, &root).unwrap();
        host.set_project_trust(&root, true, false).await.unwrap();
        let id = "test";
        let file = root.join("test.sqlite");
        std::fs::File::create(&file).unwrap();
        db_save_sources(
            &host,
            window,
            vec![DataSource { id: id.into(), name: id.into(), file: Some(file.into()), ..Default::default() }],
        )
        .await
        .unwrap();

        let statements =
            ide_db::split::split("CREATE TABLE items (n INTEGER); INSERT INTO items VALUES (1);", DbDriver::Sqlite);
        let request = RequestId(1);
        let error = execute_statements(&host, window, request, id, statements, 0, 10, None, |event| match event {
            ExecutionEvent::Started { index: 0 } => Ok(()),
            ExecutionEvent::Completed { index: 0, outcome } => {
                assert!(outcome.error.is_none(), "{:?}", outcome.error);
                Err(IdeError::internal("cannot report result"))
            }
            _ => panic!("the failed callback must stop execution"),
        })
        .await
        .unwrap_err();
        assert_eq!(error.message, "cannot report result");

        // After cleanup, cancel is remembered for the next request with this id.
        host.cancel_request(request);
        assert!(host.begin_request(request).is_cancelled());

        let query = ide_db::split::split(
            "SELECT 99 AS n UNION ALL SELECT count(*) FROM items ORDER BY n DESC",
            DbDriver::Sqlite,
        );
        let outcomes = db_execute(&host, window, RequestId(2), id.into(), query, 1, 10, None).await.unwrap();
        assert_eq!(outcomes[0].result.as_ref().unwrap().rows, vec![vec![Some("0".into())]]);
    }
}
