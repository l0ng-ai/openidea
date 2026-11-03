//! Database commands for the remote server: the desktop shell's
//! `src-tauri/src/commands/db.rs` without `db_export_file` (whose path comes
//! from a local save dialog, so it stays local).
use crate::Host;
use crate::rpc::Dispatcher;
use ide_core::{IdeError, IdeResult, IpcPath, RequestId};
use ide_db::split::SqlStatement;
use ide_db::{DataSource, DbManager, DbObjectKind, DbRowEdit, QueryResult, SortKey};
use serde::Serialize;

/// One statement of a console run (the desktop shell's `StatementOutcome`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementOutcome {
    pub statement: SqlStatement,
    pub result: Option<QueryResult>,
    pub error: Option<String>,
}

pub(crate) fn register(d: &mut Dispatcher) {
    d.add("db_sources", |c| async move { c.host.project(&c.window)?.db.sources() });
    d.add("db_save_sources", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        db.save_sources(c.arg("sources")?).await
    });
    d.add("db_set_password", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        let (id, password, save) =
            (c.arg::<String>("id")?, c.arg::<Option<String>>("password")?, c.arg::<bool>("save")?);
        db.set_password(&id, password, save).await
    });
    d.add("db_test", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        let (source, password, ssh_secret) = (
            c.arg::<DataSource>("source")?,
            c.arg::<Option<String>>("password")?,
            c.arg::<Option<String>>("sshSecret")?,
        );
        db.test(&source, password, ssh_secret).await
    });
    d.add("db_set_ssh_secret", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        let (id, secret, save) = (c.arg::<String>("id")?, c.arg::<Option<String>>("secret")?, c.arg::<bool>("save")?);
        db.set_ssh_secret(&id, secret, save).await
    });
    d.add("db_trust_ssh_host", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        db.trust_ssh_host(&c.arg::<String>("id")?).await
    });
    d.add("db_connected", |c| async move { Ok(c.host.project(&c.window)?.db.connected()) });
    d.add("db_connect", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        db.pool(&c.arg::<String>("id")?).await.map(|_| ())
    });
    d.add("db_set_manual_commit", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        let (id, manual) = (c.arg::<String>("id")?, c.arg::<bool>("manual")?);
        db.set_manual_commit(&id, manual).await;
        Ok(())
    });
    d.add("db_finish_transaction", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        let (id, commit) = (c.arg::<String>("id")?, c.arg::<bool>("commit")?);
        db.finish_transaction(&id, commit).await
    });
    d.add("db_disconnect", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        db.disconnect(&c.arg::<String>("id")?).await;
        Ok(())
    });
    d.add("db_databases", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        db.databases(&c.arg::<String>("id")?).await
    });
    d.add("db_schemas", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        db.schemas(&c.arg::<String>("id")?).await
    });
    d.add("db_tables", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        let (id, schema) = (c.arg::<String>("id")?, c.arg::<String>("schema")?);
        db.tables(&id, &schema).await
    });
    d.add("db_table_details", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        let (id, schema, table) = (c.arg::<String>("id")?, c.arg::<String>("schema")?, c.arg::<String>("table")?);
        db.table_details(&id, &schema, &table).await
    });
    d.add("db_ddl", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        let (id, schema, table) = (c.arg::<String>("id")?, c.arg::<String>("schema")?, c.arg::<String>("table")?);
        db.ddl(&id, &schema, &table).await
    });
    d.add("db_schema_objects", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        let (id, schema) = (c.arg::<String>("id")?, c.arg::<String>("schema")?);
        db.schema_objects(&id, &schema).await
    });
    d.add("db_object_ddl", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        let (id, schema, kind, name) = (
            c.arg::<String>("id")?,
            c.arg::<String>("schema")?,
            c.arg::<DbObjectKind>("kind")?,
            c.arg::<String>("name")?,
        );
        db.object_ddl(&id, &schema, kind, &name).await
    });
    d.add("db_explain", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        let (request, id, statement) =
            (c.arg::<RequestId>("request")?, c.arg::<String>("id")?, c.arg::<String>("statement")?);
        let cancel = c.host.begin_request(request);
        let result = db.explain(&id, &statement, &cancel).await;
        c.host.end_request(request);
        result
    });
    d.add("db_history", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        db.history(&c.arg::<String>("id")?).await
    });
    d.add("db_remove_history", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        let (id, texts) = (c.arg::<String>("id")?, c.arg::<Option<Vec<String>>>("texts")?);
        db.remove_history(&id, texts).await
    });
    d.add("db_completion", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        db.completion(&c.arg::<String>("id")?).await
    });
    d.add("db_statements", |c| async move {
        let (id, text, from, to) =
            (c.arg::<String>("id")?, c.arg::<String>("text")?, c.arg::<u32>("from")?, c.arg::<u32>("to")?);
        let driver = c.host.project(&c.window)?.db.source(&id)?.driver;
        Ok(if from < to {
            ide_db::split::statements_in(&text, from, to, driver)
        } else {
            ide_db::split::statement_at(&text, from, driver).into_iter().collect()
        })
    });
    d.add("db_execute", |c| async move {
        let (request, id, statements, max_rows) = (
            c.arg::<RequestId>("request")?,
            c.arg::<String>("id")?,
            c.arg::<Vec<SqlStatement>>("statements")?,
            c.arg::<u32>("maxRows")?,
        );
        let project = c.host.project(&c.window)?;
        execute(&project.db, &c.host, request, &id, statements, max_rows).await
    });
    d.add("db_table_page", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
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
        let cancel = c.host.begin_request(request);
        let result = db
            .table_page(&id, &schema, &table, filter.as_deref(), &sort, offset.into(), limit.max(1).into(), &cancel)
            .await;
        c.host.end_request(request);
        result
    });
    d.add("db_apply_edits", |c| async move {
        let db = c.host.project(&c.window)?.db.clone();
        let (id, schema, table, edits) = (
            c.arg::<String>("id")?,
            c.arg::<String>("schema")?,
            c.arg::<String>("table")?,
            c.arg::<Vec<DbRowEdit>>("edits")?,
        );
        Ok(db.apply_edits(&id, &schema, &table, &edits).await? as f64)
    });
    d.add("db_console_path", |c| async move { console_path(&c.host, &c.arg::<String>("id")?) });
}

/// Runs `statements` in order on data source `id`, stopping at the first
/// error. Cancel with `cancel_request(request)`.
async fn execute(
    db: &DbManager,
    host: &Host,
    request: RequestId,
    id: &str,
    statements: Vec<SqlStatement>,
    max_rows: u32,
) -> IdeResult<Vec<StatementOutcome>> {
    let cancel = host.begin_request(request);
    let mut out = Vec::new();
    for statement in statements {
        match db.execute(id, &statement.text, max_rows.max(1) as usize, &cancel).await {
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

/// The query console file of data source `id` (`<dataDir>/consoles/db/<id>/console.sql`),
/// created on first use.
fn console_path(host: &Host, id: &str) -> IdeResult<IpcPath> {
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
