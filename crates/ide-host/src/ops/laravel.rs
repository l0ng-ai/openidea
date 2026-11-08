//! Laravel commands of the native PHP engine that the editor runs itself:
//! the "Create translation key…" dialog writes the texts it asked for with
//! [`php_laravel_create_translation`].
//!
//! The live database schema (Settings › PHP › Laravel › Database): the tables and columns
//! of the chosen data source are read through `ide-db` and given to the engine
//! ([`refresh_schema`]) when the project opens, when the setting changes, on demand
//! ([`php_laravel_refresh_schema`]), and when the Database tool reports a schema change
//! (it read the data source's schema again, or ran a DDL statement on it).

use std::sync::Arc;

use crate::Host;
use crate::project::Project;
use ide_core::{IdeError, IdeResult, WorkspaceEdit};
use ide_db::CompletionModel;
use ide_php::frameworks::laravel::{LiveColumn, LiveSchema, LiveTable};
use serde::{Deserialize, Serialize};
use specta::Type;

/// One locale's text for a new translation key.
#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranslationText {
    pub locale: String,
    pub text: String,
}

/// The edit adding translation `key` with each locale's text to that
/// locale's files (a group file's nested arrays, or the JSON file; locales
/// that have the key are left as they are). Fails while the native PHP
/// engine isn't running, outside Laravel projects, and when the key can't
/// be added.
pub async fn php_laravel_create_translation(
    host: &Host,
    window: &str,
    key: String,
    texts: Vec<TranslationText>,
) -> IdeResult<WorkspaceEdit> {
    let project = host.project(window)?;
    let Some(engine) = project.php.engine() else {
        return Err(IdeError::unavailable("The native PHP engine isn't running"));
    };
    host.blocking(move || {
        let texts: Vec<(String, String)> = texts.into_iter().map(|t| (t.locale, t.text)).collect();
        engine
            .laravel_create_translation(&key, &texts)
            .ok_or_else(|| IdeError::invalid(format!("The translation key '{key}' can't be added")))
    })
    .await
}

/// The live schema in use: the data source's name and how many tables it has.
#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaravelSchemaStatus {
    pub source: String,
    pub tables: u32,
}

/// Reads the schema of the data source chosen in Settings › PHP › Laravel again and gives
/// it to the PHP engine. `None` when no data source is chosen (the migrations alone are
/// used); fails when the data source is unknown or can't be read.
pub async fn php_laravel_refresh_schema(host: &Host, window: &str) -> IdeResult<Option<LaravelSchemaStatus>> {
    let project = host.project(window)?;
    refresh_schema(&project).await
}

/// See [`php_laravel_refresh_schema`].
pub(crate) async fn refresh_schema(project: &Project) -> IdeResult<Option<LaravelSchemaStatus>> {
    let id = project.settings.effective().languages.php.laravel.database;
    if id.is_empty() {
        project.php.set_live_schema("", None);
        return Ok(None);
    }
    let source = project.db.source(&id)?;
    let model = match project.db.completion(&id).await {
        Ok(model) => model,
        Err(e) => {
            project.php.set_live_schema(&id, None);
            return Err(e);
        }
    };
    let schema = live_schema(&source.name, &model);
    let status = LaravelSchemaStatus { source: source.name, tables: schema.tables.len() as u32 };
    project.php.set_live_schema(&id, Some(schema));
    Ok(Some(status))
}

/// Refreshes the live schema in the background when the chosen data source differs from
/// the one in use (the project opened, or the setting changed).
pub(crate) fn refresh_schema_if_changed(project: &Arc<Project>, runtime: &tokio::runtime::Handle) {
    let wanted = project.settings.effective().languages.php.laravel.database;
    if wanted == project.php.live_schema_source() {
        return;
    }
    let project = project.clone();
    runtime.spawn(async move {
        if let Err(e) = refresh_schema(&project).await {
            tracing::warn!("laravel database schema: {}", e.message);
        }
    });
}

/// The Database tool read the schema of data source `id` (`model`): the engine uses it when
/// it is the data source of Settings › PHP › Laravel.
pub(crate) fn schema_read(project: &Project, id: &str, model: &CompletionModel) {
    if id.is_empty() || project.settings.effective().languages.php.laravel.database != id {
        return;
    }
    if let Ok(source) = project.db.source(id) {
        project.php.set_live_schema(id, Some(live_schema(&source.name, model)));
    }
}

/// The Database tool changed the schema of data source `id` (ran a DDL statement): the
/// schema is read again in the background when it is the data source in use.
pub(crate) fn schema_changed(project: &Arc<Project>, id: &str, runtime: &tokio::runtime::Handle) {
    if id.is_empty() || project.settings.effective().languages.php.laravel.database != id {
        return;
    }
    let project = project.clone();
    runtime.spawn(async move {
        if let Err(e) = refresh_schema(&project).await {
            tracing::warn!("laravel database schema: {}", e.message);
        }
    });
}

/// Whether `statement` changes the schema (`CREATE`, `ALTER`, `DROP`, `RENAME`).
pub(crate) fn is_schema_statement(statement: &str) -> bool {
    let first = statement.trim_start().split(|c: char| !c.is_ascii_alphabetic()).next().unwrap_or_default();
    ["create", "alter", "drop", "rename"].iter().any(|word| first.eq_ignore_ascii_case(word))
}

/// The tables of the completion model's default schema (Laravel names tables without a
/// schema), as the engine takes them.
pub(crate) fn live_schema(source: &str, model: &CompletionModel) -> LiveSchema {
    let tables = model
        .tables
        .iter()
        .filter(|table| model.default_schema.is_empty() || table.schema == model.default_schema)
        .filter(|table| !table.name.starts_with("sqlite_"))
        .map(|table| LiveTable {
            name: table.name.clone(),
            columns: table
                .columns
                .iter()
                .map(|column| LiveColumn {
                    name: column.name.clone(),
                    data_type: column.data_type.clone(),
                    nullable: column.nullable,
                })
                .collect(),
        })
        .collect();
    LiveSchema { source: source.to_owned(), tables }
}

pub(crate) fn register(d: &mut crate::rpc::Dispatcher) {
    d.add("php_laravel_create_translation", |c| async move {
        php_laravel_create_translation(&c.host, &c.window, c.arg("key")?, c.arg("texts")?).await
    });
    d.add("php_laravel_refresh_schema", |c| async move { php_laravel_refresh_schema(&c.host, &c.window).await });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_schema_statements() {
        assert!(is_schema_statement("CREATE TABLE posts (id int)"));
        assert!(is_schema_statement("  alter table posts add column x int"));
        assert!(is_schema_statement("DROP VIEW v"));
        assert!(!is_schema_statement("SELECT * FROM posts"));
        assert!(!is_schema_statement("INSERT INTO created VALUES (1)"));
        assert!(!is_schema_statement("creates"));
    }
}
