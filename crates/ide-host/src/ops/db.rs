//! Database commands shared by the desktop shell's IPC commands and the
//! remote server ([`crate::rpc`]). `db_export_file` stays in the desktop
//! shell: its path comes from a local save dialog, so the export must land
//! on the user's machine, not the side the project runs on.
use crate::Host;
use crate::rpc::Dispatcher;
use ide_core::{IdeError, IdeResult, IpcPath, RequestId};
use ide_db::split::SqlStatement;
use ide_db::{
    CompletionModel, DataSource, Databases, DbObjectKind, DbRowEdit, HistoryEntry, PlanNode, QueryResult,
    SchemaObjects, SortKey, TableDetails, TableInfo, TablePage,
};
use serde::{Deserialize, Serialize};
use specta::Type;

/// One statement of a console run.
#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbStatementOutcome")]
pub struct StatementOutcome {
    pub statement: SqlStatement,
    pub result: Option<QueryResult>,
    pub error: Option<String>,
}

pub(crate) fn register(d: &mut Dispatcher) {
    d.add("db_sources", |c| async move { sources(&c.host, &c.window) });
    d.add("db_save_sources", |c| async move {
        let sources = c.arg("sources")?;
        save_sources(&c.host, &c.window, sources).await
    });
    d.add("db_set_password", |c| async move {
        let (id, password, save) =
            (c.arg::<String>("id")?, c.arg::<Option<String>>("password")?, c.arg::<bool>("save")?);
        set_password(&c.host, &c.window, &id, password, save).await
    });
    d.add("db_test", |c| async move {
        let (source, password, ssh_secret) = (
            c.arg::<DataSource>("source")?,
            c.arg::<Option<String>>("password")?,
            c.arg::<Option<String>>("sshSecret")?,
        );
        test(&c.host, &c.window, source, password, ssh_secret).await
    });
    d.add("db_set_ssh_secret", |c| async move {
        let (id, secret, save) = (c.arg::<String>("id")?, c.arg::<Option<String>>("secret")?, c.arg::<bool>("save")?);
        set_ssh_secret(&c.host, &c.window, &id, secret, save).await
    });
    d.add("db_trust_ssh_host", |c| async move {
        let id = c.arg::<String>("id")?;
        trust_ssh_host(&c.host, &c.window, &id).await
    });
    d.add("db_connected", |c| async move { connected(&c.host, &c.window) });
    d.add("db_connect", |c| async move {
        let id = c.arg::<String>("id")?;
        connect(&c.host, &c.window, &id).await
    });
    d.add("db_set_manual_commit", |c| async move {
        let (id, manual) = (c.arg::<String>("id")?, c.arg::<bool>("manual")?);
        set_manual_commit(&c.host, &c.window, &id, manual).await
    });
    d.add("db_finish_transaction", |c| async move {
        let (id, commit) = (c.arg::<String>("id")?, c.arg::<bool>("commit")?);
        finish_transaction(&c.host, &c.window, &id, commit).await
    });
    d.add("db_disconnect", |c| async move {
        let id = c.arg::<String>("id")?;
        disconnect(&c.host, &c.window, &id).await
    });
    d.add("db_databases", |c| async move {
        let id = c.arg::<String>("id")?;
        databases(&c.host, &c.window, &id).await
    });
    d.add("db_database_catalog", |c| async move {
        let (id, database) = (c.arg::<String>("id")?, c.arg::<String>("database")?);
        database_catalog(&c.host, &c.window, &id, &database).await
    });
    d.add("db_saved_catalog", |c| async move {
        let id = c.arg::<String>("id")?;
        saved_catalog(&c.host, &c.window, &id).await
    });
    d.add("db_retain_catalog", |c| async move {
        let (id, databases) = (c.arg::<String>("id")?, c.arg::<Vec<String>>("databases")?);
        retain_catalog(&c.host, &c.window, &id, databases).await
    });
    d.add("db_session_context", |c| async move {
        let id = c.arg::<String>("id")?;
        session_context(&c.host, &c.window, &id).await
    });
    d.add("db_schemas", |c| async move {
        let id = c.arg::<String>("id")?;
        schemas(&c.host, &c.window, &id).await
    });
    d.add("db_tables", |c| async move {
        let (id, schema) = (c.arg::<String>("id")?, c.arg::<String>("schema")?);
        tables(&c.host, &c.window, &id, &schema).await
    });
    d.add("db_table_details", |c| async move {
        let (id, schema, table) = (c.arg::<String>("id")?, c.arg::<String>("schema")?, c.arg::<String>("table")?);
        table_details(&c.host, &c.window, &id, &schema, &table).await
    });
    d.add("db_ddl", |c| async move {
        let (id, schema, table) = (c.arg::<String>("id")?, c.arg::<String>("schema")?, c.arg::<String>("table")?);
        ddl(&c.host, &c.window, &id, &schema, &table).await
    });
    d.add("db_schema_objects", |c| async move {
        let (id, schema) = (c.arg::<String>("id")?, c.arg::<String>("schema")?);
        schema_objects(&c.host, &c.window, &id, &schema).await
    });
    d.add("db_object_ddl", |c| async move {
        let (id, schema, kind, name) = (
            c.arg::<String>("id")?,
            c.arg::<String>("schema")?,
            c.arg::<DbObjectKind>("kind")?,
            c.arg::<String>("name")?,
        );
        object_ddl(&c.host, &c.window, &id, &schema, kind, &name).await
    });
    d.add("db_explain", |c| async move {
        let (request, id, statement) =
            (c.arg::<RequestId>("request")?, c.arg::<String>("id")?, c.arg::<String>("statement")?);
        let schema = c.arg::<Option<String>>("schema")?;
        explain(&c.host, &c.window, request, &id, &statement, schema.as_deref()).await
    });
    d.add("db_history", |c| async move {
        let id = c.arg::<String>("id")?;
        history(&c.host, &c.window, &id).await
    });
    d.add("db_remove_history", |c| async move {
        let (id, texts) = (c.arg::<String>("id")?, c.arg::<Option<Vec<String>>>("texts")?);
        remove_history(&c.host, &c.window, &id, texts).await
    });
    d.add("db_completion", |c| async move {
        let id = c.arg::<String>("id")?;
        completion(&c.host, &c.window, &id).await
    });
    d.add("db_statements", |c| async move {
        let (id, text, from, to) =
            (c.arg::<String>("id")?, c.arg::<String>("text")?, c.arg::<u32>("from")?, c.arg::<u32>("to")?);
        statements(&c.host, &c.window, &id, &text, from, to)
    });
    d.add("db_execute", |c| async move {
        let (request, id, statements, skip, max_rows) = (
            c.arg::<RequestId>("request")?,
            c.arg::<String>("id")?,
            c.arg::<Vec<SqlStatement>>("statements")?,
            c.arg::<Option<u32>>("skip")?.unwrap_or(0),
            c.arg::<u32>("maxRows")?,
        );
        let schema = c.arg::<Option<String>>("schema")?;
        execute(&c.host, &c.window, request, &id, statements, skip, max_rows, schema.as_deref()).await
    });
    d.add("db_table_page", |c| async move {
        let (request, id, schema, table) = (
            c.arg::<RequestId>("request")?,
            c.arg::<String>("id")?,
            c.arg::<String>("schema")?,
            c.arg::<String>("table")?,
        );
        let (filter, sort, offset, limit) = (
            c.arg::<Option<String>>("filter")?,
            c.arg::<Vec<SortKey>>("sort")?,
            c.arg::<u32>("offset")?,
            c.arg::<u32>("limit")?,
        );
        table_page(&c.host, &c.window, request, &id, &schema, &table, filter, sort, offset, limit).await
    });
    d.add("db_apply_edits", |c| async move {
        let (id, schema, table, edits) = (
            c.arg::<String>("id")?,
            c.arg::<String>("schema")?,
            c.arg::<String>("table")?,
            c.arg::<Vec<DbRowEdit>>("edits")?,
        );
        apply_edits(&c.host, &c.window, &id, &schema, &table, edits).await
    });
    d.add("db_console_path", |c| async move { console_path(&c.host, &c.arg::<String>("id")?) });
}

/// The data sources configured for the project (the tree's roots).
pub fn sources(host: &Host, window: &str) -> IdeResult<Vec<DataSource>> {
    host.project(window)?.db.sources()
}

/// Replaces the project's data sources with `sources`.
pub async fn save_sources(host: &Host, window: &str, sources: Vec<DataSource>) -> IdeResult<()> {
    let db = host.project(window)?.db.clone();
    db.save_sources(sources).await?;
    let root = host.project(window)?.root.clone();
    for project in host.projects().into_iter().filter(|p| p.root == root) {
        project.sink.emit(ide_core::IdeEvent::DbSourcesChanged);
    }
    Ok(())
}

/// Remembers the password of data source `id` for the session, and in the OS
/// saved passwords when `save` (`None` forgets it).
pub async fn set_password(host: &Host, window: &str, id: &str, password: Option<String>, save: bool) -> IdeResult<()> {
    let db = host.project(window)?.db.clone();
    db.set_password(id, password, save).await
}

/// Test Connection: connects with unsaved settings and returns the server version.
pub async fn test(
    host: &Host,
    window: &str,
    source: DataSource,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> IdeResult<String> {
    let db = host.project(window)?.db.clone();
    db.test(&source, password, ssh_secret).await
}

/// Remembers the SSH password / key passphrase of a data source (see `set_password`).
pub async fn set_ssh_secret(host: &Host, window: &str, id: &str, secret: Option<String>, save: bool) -> IdeResult<()> {
    let db = host.project(window)?.db.clone();
    db.set_ssh_secret(id, secret, save).await
}

/// Trusts the SSH host key that made the last connection of `id` fail with
/// "Unknown SSH host key" (records it in `~/.ssh/known_hosts`).
pub async fn trust_ssh_host(host: &Host, window: &str, id: &str) -> IdeResult<()> {
    let db = host.project(window)?.db.clone();
    db.trust_ssh_host(id).await
}

/// The data sources with an open connection.
pub fn connected(host: &Host, window: &str) -> IdeResult<Vec<String>> {
    Ok(host.project(window)?.db.connected())
}

/// Connects (fails with `permissionDenied` when the password is missing or wrong).
pub async fn connect(host: &Host, window: &str, id: &str) -> IdeResult<()> {
    let db = host.project(window)?.db.clone();
    db.pool(id).await.map(|_| ())
}

/// Switches a data source between auto-commit and manual commit (leaving
/// manual mode rolls back what was not committed).
pub async fn set_manual_commit(host: &Host, window: &str, id: &str, manual: bool) -> IdeResult<()> {
    let db = host.project(window)?.db.clone();
    db.set_manual_commit(id, manual).await
}

/// Commits or rolls back the open transaction of a manual-commit data source.
pub async fn finish_transaction(host: &Host, window: &str, id: &str, commit: bool) -> IdeResult<()> {
    let db = host.project(window)?.db.clone();
    db.finish_transaction(id, commit).await
}

/// Closes the connection of data source `id`.
pub async fn disconnect(host: &Host, window: &str, id: &str) -> IdeResult<()> {
    let db = host.project(window)?.db.clone();
    db.disconnect(id).await;
    Ok(())
}

/// Databases of the server of data source `id` (PostgreSQL); connect to one as `<id>:<database>`.
pub async fn databases(host: &Host, window: &str, id: &str) -> IdeResult<Databases> {
    let db = host.project(window)?.db.clone();
    db.databases(id).await
}

/// The schemas of `database` of Snowflake data source `id` with their tables and views.
pub async fn database_catalog(
    host: &Host,
    window: &str,
    id: &str,
    database: &str,
) -> IdeResult<Vec<ide_db::CatalogSchema>> {
    let db = host.project(window)?.db.clone();
    db.database_catalog(id, database).await
}

/// What earlier introspection of data source `id` saved; the data source is not connected to.
pub async fn saved_catalog(host: &Host, window: &str, id: &str) -> IdeResult<Option<ide_db::SourceCatalog>> {
    let db = host.project(window)?.db.clone();
    db.saved_catalog(id).await
}

/// Drops the saved databases of data source `id` that are not in `databases` any more.
pub async fn retain_catalog(host: &Host, window: &str, id: &str, databases: Vec<String>) -> IdeResult<()> {
    let db = host.project(window)?.db.clone();
    db.retain_catalog(id, databases).await
}

/// The warehouse and role of the Snowflake session of data source `id`, and what it may switch to.
pub async fn session_context(host: &Host, window: &str, id: &str) -> IdeResult<ide_db::SessionContext> {
    let db = host.project(window)?.db.clone();
    db.session_context(id).await
}

/// The schemas of data source `id`.
pub async fn schemas(host: &Host, window: &str, id: &str) -> IdeResult<Vec<String>> {
    let db = host.project(window)?.db.clone();
    db.schemas(id).await
}

/// The tables and views of `schema`.
pub async fn tables(host: &Host, window: &str, id: &str, schema: &str) -> IdeResult<Vec<TableInfo>> {
    let db = host.project(window)?.db.clone();
    db.tables(id, schema).await
}

/// Columns, keys and indexes of `table`.
pub async fn table_details(host: &Host, window: &str, id: &str, schema: &str, table: &str) -> IdeResult<TableDetails> {
    let db = host.project(window)?.db.clone();
    db.table_details(id, schema, table).await
}

/// The DDL of table or view `table` (Go to DDL, Generate DDL).
pub async fn ddl(host: &Host, window: &str, id: &str, schema: &str, table: &str) -> IdeResult<String> {
    let db = host.project(window)?.db.clone();
    db.ddl(id, schema, table).await
}

/// The routines and sequences of `schema` (the tree's `routines` / `sequences`).
pub async fn schema_objects(host: &Host, window: &str, id: &str, schema: &str) -> IdeResult<SchemaObjects> {
    let db = host.project(window)?.db.clone();
    db.schema_objects(id, schema).await
}

/// The definition of a routine, trigger or sequence (Go to DDL, Quick Documentation).
pub async fn object_ddl(
    host: &Host,
    window: &str,
    id: &str,
    schema: &str,
    kind: DbObjectKind,
    name: &str,
) -> IdeResult<String> {
    let db = host.project(window)?.db.clone();
    db.object_ddl(id, schema, kind, name).await
}

/// Explain Plan: the execution plan of `statement` on `id`, without running it.
pub async fn explain(
    host: &Host,
    window: &str,
    request: RequestId,
    id: &str,
    statement: &str,
    schema: Option<&str>,
) -> IdeResult<Vec<PlanNode>> {
    let db = host.project(window)?.db.clone();
    let cancel = host.begin_request(request);
    let result = db.explain(id, statement, &cancel, schema).await;
    host.end_request(request);
    result
}

/// The statements data source `id` ran, newest first (Browse Query History).
pub async fn history(host: &Host, window: &str, id: &str) -> IdeResult<Vec<HistoryEntry>> {
    let db = host.project(window)?.db.clone();
    db.history(id).await
}

/// Removes statements from the query history of `id` (`None`: all of them).
pub async fn remove_history(host: &Host, window: &str, id: &str, texts: Option<Vec<String>>) -> IdeResult<()> {
    let db = host.project(window)?.db.clone();
    db.remove_history(id, texts).await
}

/// Tables, columns and foreign keys for SQL completion.
pub async fn completion(host: &Host, window: &str, id: &str) -> IdeResult<CompletionModel> {
    let db = host.project(window)?.db.clone();
    db.completion(id).await
}

/// Statements a console runs: the selection's (`from < to`) or the one at the caret (`from`).
pub fn statements(host: &Host, window: &str, id: &str, text: &str, from: u32, to: u32) -> IdeResult<Vec<SqlStatement>> {
    let driver = host.project(window)?.db.source(id)?.driver;
    Ok(if from < to {
        ide_db::split::statements_in(text, from, to, driver)
    } else {
        ide_db::split::statement_at(text, from, driver).into_iter().collect()
    })
}

/// Runs `statements` in order on data source `id`, stopping at the first
/// error. Each result reads past its first `skip` rows (a later page) and keeps
/// `max_rows`. `schema` is the console's active context: the connection running
/// each statement is put in it first. Cancel with `cancel_request(request)`.
#[allow(clippy::too_many_arguments)]
pub async fn execute(
    host: &Host,
    window: &str,
    request: RequestId,
    id: &str,
    statements: Vec<SqlStatement>,
    skip: u32,
    max_rows: u32,
    schema: Option<&str>,
) -> IdeResult<Vec<StatementOutcome>> {
    let db = host.project(window)?.db.clone();
    let cancel = host.begin_request(request);
    let mut out = Vec::new();
    for statement in statements {
        match db.execute_from(id, &statement.text, skip as usize, max_rows.max(1) as usize, &cancel, schema).await {
            Ok(result) => out.push(StatementOutcome { statement, result: Some(result), error: None }),
            Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled => {
                host.end_request(request);
                return Err(e);
            }
            Err(e) if e.kind == ide_core::error::ErrorKind::PermissionDenied && out.is_empty() => {
                // Not connected for lack of a password: the UI asks and retries.
                host.end_request(request);
                return Err(e);
            }
            Err(e) => {
                out.push(StatementOutcome { statement, result: None, error: Some(e.message) });
                break;
            }
        }
    }
    host.end_request(request);
    Ok(out)
}

/// One page of the rows of `table` (the table editor).
#[allow(clippy::too_many_arguments)]
pub async fn table_page(
    host: &Host,
    window: &str,
    request: RequestId,
    id: &str,
    schema: &str,
    table: &str,
    filter: Option<String>,
    sort: Vec<SortKey>,
    offset: u32,
    limit: u32,
) -> IdeResult<TablePage> {
    let db = host.project(window)?.db.clone();
    let cancel = host.begin_request(request);
    let result =
        db.table_page(id, schema, table, filter.as_deref(), &sort, offset.into(), limit.max(1).into(), &cancel).await;
    host.end_request(request);
    result
}

/// Submits the table editor's changes in one transaction; returns the rows changed.
pub async fn apply_edits(
    host: &Host,
    window: &str,
    id: &str,
    schema: &str,
    table: &str,
    edits: Vec<DbRowEdit>,
) -> IdeResult<f64> {
    let db = host.project(window)?.db.clone();
    Ok(db.apply_edits(id, schema, table, &edits).await? as f64)
}

/// The query console file of data source `id` (`<dataDir>/consoles/db/<id>/console.sql`),
/// created on first use. Consoles are files of the project, so a remote
/// window resolves it on the host the project runs on.
pub fn console_path(host: &Host, id: &str) -> IdeResult<IpcPath> {
    let (source, database) = ide_db::split_target(id);
    if source.is_empty() || !source.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(IdeError::invalid("invalid data source id"));
    }
    // One console per database: `<id>` for the default one, `<id>.<database>` for the others.
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
    let file = dir.join("console.sql");
    if !file.exists() {
        std::fs::write(&file, "")?;
    }
    Ok(file.into())
}
