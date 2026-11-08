//! Laravel commands of the native PHP engine that the editor runs itself:
//! the "Create translation key…" dialog writes the texts it asked for with
//! [`php_laravel_create_translation`]; the Eloquent model view (opened from the
//! lens on a model class) shows [`php_laravel_model_view`], and its **Add columns**
//! button applies [`php_laravel_add_columns`].
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
use ide_php::frameworks::laravel::model_view::{
    ColumnSource, ModelLocation, ModelMember, ModelView, NewColumn, RelatedKind,
};
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

/// A place in a file of the model view.
#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaravelLocation {
    pub path: ide_core::IpcPath,
    pub range: ide_core::Range,
}

impl From<ModelLocation> for LaravelLocation {
    fn from(location: ModelLocation) -> Self {
        Self { path: location.path.into(), range: location.range }
    }
}

/// A column of a model's table.
#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaravelModelColumn {
    pub name: String,
    /// The PHP type reading the column gives (before casts).
    pub ty: String,
    pub nullable: bool,
    /// The model's cast of it.
    pub cast: Option<String>,
    /// `migration` or `database`.
    pub source: String,
    /// The data source's name, for columns of the database.
    pub database: Option<String>,
    pub fillable: bool,
    pub hidden: bool,
    pub location: Option<LaravelLocation>,
}

/// A relation method of a model.
#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaravelModelRelation {
    pub name: String,
    /// `HasMany`, `BelongsTo`…
    pub kind: String,
    pub related: Option<String>,
    pub many: bool,
    pub location: Option<LaravelLocation>,
}

/// A local scope or an accessor of a model.
#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaravelModelMember {
    pub name: String,
    pub method: String,
    pub ty: Option<String>,
    pub location: Option<LaravelLocation>,
}

/// A factory, resource, policy, observer or migration of a model.
#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaravelRelatedClass {
    /// `factory`, `resource`, `policy`, `observer` or `migration`.
    pub kind: String,
    pub name: String,
    pub location: LaravelLocation,
}

/// The Eloquent model view of a model class.
#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaravelModelView {
    pub class: String,
    pub name: String,
    pub location: Option<LaravelLocation>,
    pub table: String,
    pub primary_key: String,
    pub key_type: String,
    pub incrementing: bool,
    /// The columns are known for certain (a migration creates the table, or the database has it).
    pub schema_certain: bool,
    pub columns: Vec<LaravelModelColumn>,
    pub relations: Vec<LaravelModelRelation>,
    pub scopes: Vec<LaravelModelMember>,
    pub accessors: Vec<LaravelModelMember>,
    pub related: Vec<LaravelRelatedClass>,
}

fn member(member: ModelMember) -> LaravelModelMember {
    LaravelModelMember {
        name: member.name,
        method: member.method,
        ty: member.ty,
        location: member.location.map(Into::into),
    }
}

impl From<ModelView> for LaravelModelView {
    fn from(view: ModelView) -> Self {
        Self {
            class: view.class,
            name: view.name,
            location: view.location.map(Into::into),
            table: view.table,
            primary_key: view.primary_key,
            key_type: view.key_type,
            incrementing: view.incrementing,
            schema_certain: view.schema_certain,
            columns: view
                .columns
                .into_iter()
                .map(|column| LaravelModelColumn {
                    name: column.name,
                    ty: column.ty,
                    nullable: column.nullable,
                    cast: column.cast,
                    source: match column.source {
                        ColumnSource::Migration => "migration",
                        ColumnSource::Database => "database",
                    }
                    .to_owned(),
                    database: column.database,
                    fillable: column.fillable,
                    hidden: column.hidden,
                    location: column.location.map(Into::into),
                })
                .collect(),
            relations: view
                .relations
                .into_iter()
                .map(|relation| LaravelModelRelation {
                    name: relation.name,
                    kind: relation.kind,
                    related: relation.related,
                    many: relation.many,
                    location: relation.location.map(Into::into),
                })
                .collect(),
            scopes: view.scopes.into_iter().map(member).collect(),
            accessors: view.accessors.into_iter().map(member).collect(),
            related: view
                .related
                .into_iter()
                .map(|related| LaravelRelatedClass {
                    kind: match related.kind {
                        RelatedKind::Factory => "factory",
                        RelatedKind::Resource => "resource",
                        RelatedKind::Policy => "policy",
                        RelatedKind::Observer => "observer",
                        RelatedKind::Migration => "migration",
                    }
                    .to_owned(),
                    name: related.name,
                    location: related.location.into(),
                })
                .collect(),
        }
    }
}

/// The Eloquent model view of model `class` (its table, columns, relations, scopes,
/// accessors and related classes). Fails while the native PHP engine isn't running and
/// when `class` isn't a model of a Laravel project.
pub async fn php_laravel_model_view(host: &Host, window: &str, class: String) -> IdeResult<LaravelModelView> {
    let project = host.project(window)?;
    let Some(engine) = project.php.engine() else {
        return Err(IdeError::unavailable("The native PHP engine isn't running"));
    };
    host.blocking(move || {
        engine
            .laravel_model_view(&class)
            .map(LaravelModelView::from)
            .ok_or_else(|| IdeError::invalid(format!("'{class}' is not an Eloquent model")))
    })
    .await
}

/// A column the model view's **Add columns** button adds.
#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaravelNewColumn {
    pub name: String,
    /// The `Blueprint` method making it (`string`, `foreignId`).
    pub ty: String,
    pub nullable: bool,
}

/// The edit of the model view's **Add columns** button: a new migration
/// (`<timestamp>_add_…_to_<table>_table.php`, `timestamp` like `2024_05_01_120000`) adding
/// `columns` to the table of model `class`, and, when `fillable`, the columns added to the
/// model's `$fillable`. Fails for invalid or existing column names.
pub async fn php_laravel_add_columns(
    host: &Host,
    window: &str,
    class: String,
    columns: Vec<LaravelNewColumn>,
    fillable: bool,
    timestamp: String,
) -> IdeResult<WorkspaceEdit> {
    let project = host.project(window)?;
    let Some(engine) = project.php.engine() else {
        return Err(IdeError::unavailable("The native PHP engine isn't running"));
    };
    host.blocking(move || {
        let columns: Vec<NewColumn> =
            columns.into_iter().map(|c| NewColumn { name: c.name, ty: c.ty, nullable: c.nullable }).collect();
        engine.laravel_add_columns(&class, &columns, fillable, &timestamp).map_err(IdeError::invalid)
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
    d.add(
        "php_laravel_model_view",
        |c| async move { php_laravel_model_view(&c.host, &c.window, c.arg("model")?).await },
    );
    d.add("php_laravel_add_columns", |c| async move {
        php_laravel_add_columns(
            &c.host,
            &c.window,
            c.arg("model")?,
            c.arg("columns")?,
            c.arg("fillable")?,
            c.arg("timestamp")?,
        )
        .await
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
